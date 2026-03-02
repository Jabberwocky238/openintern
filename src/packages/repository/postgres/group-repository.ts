import type { IPostgresPool } from '../interfaces/postgres-client.js';
import type { Group, CreateGroup, GroupMember, AddMember } from '../../../types/orchestrator.js';
import { generateGroupId, generateGroupMemberId, generateAgentInstanceId } from '@openintern/utils';
import { NotFoundError } from '@openintern/utils';
import type { IGroupRepository } from '../interfaces/group-repository.js';

interface GroupRow {
  id: string;
  name: string;
  description: string;
  project_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface MemberRow {
  id: string;
  group_id: string;
  role_id: string;
  agent_instance_id: string | null;
  ordinal: number;
  created_at: string | Date;
}

interface GroupWithRoleRow extends GroupRow {
  role_id: string | null;
  role_name: string | null;
  role_description: string | null;
}

export interface GroupRoleMember {
  role_id: string;
  role_name: string;
  role_description: string;
}

export interface GroupWithRoles extends Group {
  members: GroupRoleMember[];
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapGroupRow(row: GroupRow): Group {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    project_id: row.project_id,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function mapMemberRow(row: MemberRow): GroupMember {
  return {
    id: row.id,
    group_id: row.group_id,
    role_id: row.role_id,
    agent_instance_id: row.agent_instance_id,
    ordinal: row.ordinal,
    created_at: toIso(row.created_at),
  };
}

export class GroupRepository implements IGroupRepository {
  constructor(private readonly pool: IPostgresPool) {}

  // ─── Group CRUD ──────────────────────────────────────────

  async createGroup(input: CreateGroup): Promise<Group> {
    const id = generateGroupId();
    const result = await this.pool.query<GroupRow>(
      `INSERT INTO groups (id, name, description, project_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, input.name, input.description ?? '', input.project_id ?? null]
    );
    const row = result.rows[0];
    if (!row) throw new Error('Failed to create group');
    return mapGroupRow(row);
  }

  async getGroup(id: string): Promise<Group | null> {
    const result = await this.pool.query<GroupRow>(
      `SELECT * FROM groups WHERE id = $1`,
      [id]
    );
    const row = result.rows[0];
    return row ? mapGroupRow(row) : null;
  }

  async requireGroup(id: string): Promise<Group> {
    const group = await this.getGroup(id);
    if (!group) throw new NotFoundError('Group', id);
    return group;
  }

  async listGroups(projectId?: string): Promise<Group[]> {
    if (projectId) {
      const result = await this.pool.query<GroupRow>(
        `SELECT * FROM groups WHERE project_id = $1 ORDER BY created_at DESC`,
        [projectId]
      );
      return result.rows.map(mapGroupRow);
    }
    const result = await this.pool.query<GroupRow>(
      `SELECT * FROM groups ORDER BY created_at DESC`
    );
    return result.rows.map(mapGroupRow);
  }

  // ─── Group + Roles query ────────────────────────────────

  async listGroupsWithRoles(projectId?: string): Promise<GroupWithRoles[]> {
    const params: unknown[] = [];
    let where = '';
    if (projectId) {
      params.push(projectId);
      where = 'WHERE g.project_id = $1';
    }

    const result = await this.pool.query<GroupWithRoleRow>(
      `SELECT g.*, r.id AS role_id, r.name AS role_name, r.description AS role_description
       FROM groups g
       LEFT JOIN group_members gm ON gm.group_id = g.id
       LEFT JOIN roles r ON r.id = gm.role_id
       ${where}
       ORDER BY g.created_at DESC, gm.ordinal ASC`,
      params
    );

    const groupMap = new Map<string, GroupWithRoles>();
    for (const row of result.rows) {
      let group = groupMap.get(row.id);
      if (!group) {
        group = { ...mapGroupRow(row), members: [] };
        groupMap.set(row.id, group);
      }
      if (row.role_id && row.role_name) {
        group.members.push({
          role_id: row.role_id,
          role_name: row.role_name,
          role_description: row.role_description ?? '',
        });
      }
    }

    return [...groupMap.values()];
  }

  // ─── Member Management ───────────────────────────────────

  async addMember(groupId: string, input: AddMember): Promise<GroupMember> {
    await this.requireGroup(groupId);
    const id = generateGroupMemberId();
    const instanceId = generateAgentInstanceId();

    // Create agent instance for this role in the group's project
    const group = await this.requireGroup(groupId);
    await this.pool.query(
      `INSERT INTO agent_instances (id, role_id, project_id)
       VALUES ($1, $2, $3)`,
      [instanceId, input.role_id, group.project_id]
    );

    const result = await this.pool.query<MemberRow>(
      `INSERT INTO group_members (id, group_id, role_id, agent_instance_id, ordinal)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, groupId, input.role_id, instanceId, input.ordinal ?? 0]
    );
    const row = result.rows[0];
    if (!row) throw new Error('Failed to add member');
    return mapMemberRow(row);
  }

  async listMembers(groupId: string): Promise<GroupMember[]> {
    const result = await this.pool.query<MemberRow>(
      `SELECT * FROM group_members WHERE group_id = $1 ORDER BY ordinal ASC`,
      [groupId]
    );
    return result.rows.map(mapMemberRow);
  }

  async removeMember(groupId: string, memberId: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM group_members WHERE id = $1 AND group_id = $2`,
      [memberId, groupId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async updateGroup(
    id: string,
    fields: Partial<Pick<Group, 'name' | 'description' | 'project_id'>>
  ): Promise<Group> {
    await this.requireGroup(id);

    const sets: string[] = [];
    const params: unknown[] = [id];
    let idx = 2;

    if (fields.name !== undefined) {
      sets.push(`name = $${idx++}`);
      params.push(fields.name);
    }
    if (fields.description !== undefined) {
      sets.push(`description = $${idx++}`);
      params.push(fields.description);
    }
    if (fields.project_id !== undefined) {
      sets.push(`project_id = $${idx++}`);
      params.push(fields.project_id);
    }

    if (sets.length === 0) {
      return this.requireGroup(id);
    }

    sets.push('updated_at = NOW()');

    const result = await this.pool.query<GroupRow>(
      `UPDATE groups SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError('Group', id);
    return mapGroupRow(row);
  }

  async assignProjectId(projectId: string, includeExisting: boolean = false): Promise<number> {
    const normalized = projectId.trim();
    if (!normalized) {
      throw new Error('projectId is required');
    }
    const result = includeExisting
      ? await this.pool.query(
          `UPDATE groups
           SET project_id = $1, updated_at = NOW()
           WHERE project_id IS DISTINCT FROM $1`,
          [normalized]
        )
      : await this.pool.query(
          `UPDATE groups
           SET project_id = $1, updated_at = NOW()
           WHERE project_id IS NULL`,
          [normalized]
        );
    return result.rowCount ?? 0;
  }

  async deleteGroup(id: string): Promise<boolean> {
    // Delete members first
    await this.pool.query(`DELETE FROM group_members WHERE group_id = $1`, [id]);
    const result = await this.pool.query(
      `DELETE FROM groups WHERE id = $1`,
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async updateMember(
    groupId: string,
    memberId: string,
    fields: { ordinal?: number }
  ): Promise<GroupMember> {
    const sets: string[] = [];
    const params: unknown[] = [memberId, groupId];
    let idx = 3;

    if (fields.ordinal !== undefined) {
      sets.push(`ordinal = $${idx++}`);
      params.push(fields.ordinal);
    }

    if (sets.length === 0) {
      const result = await this.pool.query<MemberRow>(
        `SELECT * FROM group_members WHERE id = $1 AND group_id = $2`,
        [memberId, groupId]
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundError('GroupMember', memberId);
      return mapMemberRow(row);
    }

    const result = await this.pool.query<MemberRow>(
      `UPDATE group_members SET ${sets.join(', ')} WHERE id = $1 AND group_id = $2 RETURNING *`,
      params
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError('GroupMember', memberId);
    return mapMemberRow(row);
  }

  async getGroupStats(groupId: string): Promise<{
    run_count: number;
    completed_count: number;
    failed_count: number;
    success_rate: number;
    avg_duration_ms: number | null;
  }> {
    await this.requireGroup(groupId);
    const legacyAgentId = `group:${groupId}`;
    const result = await this.pool.query<{
      run_count: string;
      completed_count: string;
      failed_count: string;
      avg_duration_ms: string | null;
    }>(
      `SELECT
        COUNT(*)::text AS run_count,
        COUNT(*) FILTER (WHERE status = 'completed')::text AS completed_count,
        COUNT(*) FILTER (WHERE status = 'failed')::text AS failed_count,
        AVG(EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000)
          FILTER (WHERE ended_at IS NOT NULL AND started_at IS NOT NULL)::text AS avg_duration_ms
      FROM runs
      WHERE group_id = $1
        OR (group_id IS NULL AND agent_id = $2)`,
      [groupId, legacyAgentId]
    );
    const row = result.rows[0];
    const runCount = Number.parseInt(row?.run_count ?? '0', 10);
    const completedCount = Number.parseInt(row?.completed_count ?? '0', 10);
    const failedCount = Number.parseInt(row?.failed_count ?? '0', 10);
    const avgDuration = row?.avg_duration_ms ? Math.round(Number.parseFloat(row.avg_duration_ms)) : null;
    return {
      run_count: runCount,
      completed_count: completedCount,
      failed_count: failedCount,
      success_rate: runCount > 0 ? completedCount / runCount : 0,
      avg_duration_ms: avgDuration,
    };
  }

  async getGroupRuns(
    groupId: string,
    limit: number = 20,
    offset: number = 0
  ): Promise<Array<{
    run_id: string;
    status: string;
    input: string;
    created_at: string;
    ended_at: string | null;
    duration_ms: number | null;
  }>> {
    await this.requireGroup(groupId);
    const legacyAgentId = `group:${groupId}`;
    const result = await this.pool.query<{
      id: string;
      status: string;
      input: string;
      created_at: string | Date;
      started_at: string | Date | null;
      ended_at: string | Date | null;
    }>(
      `SELECT id, status, input, created_at, started_at, ended_at
      FROM runs
      WHERE group_id = $1
        OR (group_id IS NULL AND agent_id = $2)
      ORDER BY created_at DESC
      LIMIT $3 OFFSET $4`,
      [groupId, legacyAgentId, limit, offset]
    );
    return result.rows.map(row => {
      const started = row.started_at ? toIso(row.started_at) : null;
      const ended = row.ended_at ? toIso(row.ended_at) : null;
      const durationMs = ended && started
        ? new Date(ended).getTime() - new Date(started).getTime()
        : null;
      return {
        run_id: row.id,
        status: row.status,
        input: row.input,
        created_at: toIso(row.created_at),
        ended_at: ended,
        duration_ms: durationMs,
      };
    });
  }
}


