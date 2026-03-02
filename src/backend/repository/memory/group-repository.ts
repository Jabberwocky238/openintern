import type { AddMember, CreateGroup, Group, GroupMember } from '../../../types/orchestrator.js';
import { NotFoundError } from '../../../utils/errors.js';
import { generateAgentInstanceId, generateGroupId, generateGroupMemberId } from '../../../utils/ids.js';
import type { IGroupRepository } from '../interfaces/group-repository.js';
import { clone, durationMs, nowIso } from './helpers.js';
import { resolveMemoryRepositoryStore, type MemoryRepositoryStore } from './store.js';

export interface GroupRoleMember {
  role_id: string;
  role_name: string;
  role_description: string;
}

export interface GroupWithRoles extends Group {
  members: GroupRoleMember[];
}

export class GroupRepository implements IGroupRepository {
  private readonly store: MemoryRepositoryStore;

  constructor(storeOrPool?: unknown) {
    this.store = resolveMemoryRepositoryStore(storeOrPool);
  }

  async createGroup(input: CreateGroup): Promise<Group> {
    const now = nowIso();
    const group: Group = {
      id: generateGroupId(),
      name: input.name,
      description: input.description ?? '',
      project_id: input.project_id ?? null,
      created_at: now,
      updated_at: now,
    };
    this.store.groups.set(group.id, clone(group));
    return clone(group);
  }

  async getGroup(id: string): Promise<Group | null> {
    const group = this.store.groups.get(id);
    return group ? clone(group) : null;
  }

  async requireGroup(id: string): Promise<Group> {
    const group = await this.getGroup(id);
    if (!group) {
      throw new NotFoundError('Group', id);
    }
    return group;
  }

  async listGroups(projectId?: string): Promise<Group[]> {
    const list = [...this.store.groups.values()]
      .filter((group) => (projectId ? group.project_id === projectId : true))
      .sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime());
    return list.map((item) => clone(item));
  }

  async listGroupsWithRoles(projectId?: string): Promise<GroupWithRoles[]> {
    const groups = await this.listGroups(projectId);
    return groups.map((group) => {
      const members = [...this.store.groupMembers.values()]
        .filter((member) => member.group_id === group.id)
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((member) => {
          const role = this.store.roles.get(member.role_id);
          return role
            ? {
                role_id: role.id,
                role_name: role.name,
                role_description: role.description,
              }
            : null;
        })
        .filter((item): item is GroupRoleMember => item !== null);
      return { ...group, members };
    });
  }

  async addMember(groupId: string, input: AddMember): Promise<GroupMember> {
    const group = await this.requireGroup(groupId);
    const now = nowIso();
    const agentInstanceId = generateAgentInstanceId();
    const member: GroupMember = {
      id: generateGroupMemberId(),
      group_id: group.id,
      role_id: input.role_id,
      agent_instance_id: agentInstanceId,
      ordinal: input.ordinal ?? 0,
      created_at: now,
    };
    this.store.agentRoleByInstance.set(agentInstanceId, input.role_id);
    this.store.groupMembers.set(member.id, clone(member));
    return clone(member);
  }

  async listMembers(groupId: string): Promise<GroupMember[]> {
    const members = [...this.store.groupMembers.values()]
      .filter((member) => member.group_id === groupId)
      .sort((a, b) => a.ordinal - b.ordinal);
    return members.map((member) => clone(member));
  }

  async removeMember(groupId: string, memberId: string): Promise<boolean> {
    const member = this.store.groupMembers.get(memberId);
    if (!member || member.group_id !== groupId) {
      return false;
    }
    if (member.agent_instance_id) {
      this.store.agentRoleByInstance.delete(member.agent_instance_id);
    }
    return this.store.groupMembers.delete(memberId);
  }

  async updateGroup(id: string, fields: Partial<Pick<Group, 'name' | 'description' | 'project_id'>>): Promise<Group> {
    const current = await this.requireGroup(id);
    const updated: Group = {
      ...current,
      ...fields,
      updated_at: nowIso(),
    };
    this.store.groups.set(id, clone(updated));
    return clone(updated);
  }

  async assignProjectId(projectId: string, includeExisting: boolean = false): Promise<number> {
    const normalized = projectId.trim();
    if (!normalized) {
      throw new Error('projectId is required');
    }
    let count = 0;
    for (const [id, group] of this.store.groups.entries()) {
      if (!includeExisting && group.project_id !== null) {
        continue;
      }
      if (includeExisting && group.project_id === normalized) {
        continue;
      }
      this.store.groups.set(id, { ...group, project_id: normalized, updated_at: nowIso() });
      count += 1;
    }
    return count;
  }

  async deleteGroup(id: string): Promise<boolean> {
    for (const [memberId, member] of this.store.groupMembers.entries()) {
      if (member.group_id === id) {
        if (member.agent_instance_id) {
          this.store.agentRoleByInstance.delete(member.agent_instance_id);
        }
        this.store.groupMembers.delete(memberId);
      }
    }
    return this.store.groups.delete(id);
  }

  async updateMember(groupId: string, memberId: string, fields: { ordinal?: number }): Promise<GroupMember> {
    const member = this.store.groupMembers.get(memberId);
    if (!member || member.group_id !== groupId) {
      throw new NotFoundError('GroupMember', memberId);
    }
    const updated = { ...member, ...fields };
    this.store.groupMembers.set(memberId, clone(updated));
    return clone(updated);
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
    const runs = [...this.store.runs.values()].filter(
      (run) => run.groupId === groupId || (run.groupId === null && run.agentId === legacyAgentId)
    );
    const completed = runs.filter((run) => run.status === 'completed').length;
    const failed = runs.filter((run) => run.status === 'failed').length;
    const durations = runs
      .map((run) => durationMs(run.startedAt, run.endedAt))
      .filter((value): value is number => value !== null);
    const avgDuration = durations.length === 0 ? null : Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
    return {
      run_count: runs.length,
      completed_count: completed,
      failed_count: failed,
      success_rate: runs.length > 0 ? completed / runs.length : 0,
      avg_duration_ms: avgDuration,
    };
  }

  async getGroupRuns(groupId: string, limit: number = 20, offset: number = 0): Promise<Array<{
    run_id: string;
    status: string;
    input: string;
    created_at: string;
    ended_at: string | null;
    duration_ms: number | null;
  }>> {
    await this.requireGroup(groupId);
    const legacyAgentId = `group:${groupId}`;
    const runs = [...this.store.runs.values()]
      .filter((run) => run.groupId === groupId || (run.groupId === null && run.agentId === legacyAgentId))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(offset, offset + limit);
    return runs.map((run) => ({
      run_id: run.id,
      status: run.status,
      input: run.input,
      created_at: run.createdAt,
      ended_at: run.endedAt,
      duration_ms: durationMs(run.startedAt, run.endedAt),
    }));
  }
}

