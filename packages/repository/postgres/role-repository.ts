import type { IPostgresPool } from '../interfaces/postgres-client.js';
import type { Role, CreateRole } from '@openintern/types/orchestrator.js';
import { generateRoleId } from '@openintern/utils';
import { NotFoundError } from '@openintern/utils';
import type { IRoleRepository } from '../interfaces/role-repository.js';
import { getPostgresPool } from './pool.js';

interface RoleRow {
  id: string;
  name: string;
  description: string;
  system_prompt: string;
  allowed_tools: string[];
  denied_tools: string[];
  style_constraints: Record<string, unknown>;
  is_lead: boolean;
  created_at: string | Date;
  updated_at: string | Date;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRoleRow(row: RoleRow): Role {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    system_prompt: row.system_prompt,
    allowed_tools: row.allowed_tools,
    denied_tools: row.denied_tools,
    style_constraints: row.style_constraints,
    is_lead: row.is_lead,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

export class RoleRepository implements IRoleRepository {
  private readonly pool: IPostgresPool;

  constructor(pool?: IPostgresPool) {
    this.pool = pool ?? getPostgresPool();
  }

  async create(input: CreateRole): Promise<Role> {
    const id = generateRoleId();
    const result = await this.pool.query<RoleRow>(
      `INSERT INTO roles (
        id, name, description, system_prompt,
        allowed_tools, denied_tools,
        style_constraints, is_lead
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8)
      RETURNING *`,
      [
        id,
        input.name,
        input.description ?? '',
        input.system_prompt,
        JSON.stringify(input.allowed_tools ?? []),
        JSON.stringify(input.denied_tools ?? []),
        JSON.stringify(input.style_constraints ?? {}),
        input.is_lead ?? false,
      ]
    );
    const row = result.rows[0];
    if (!row) throw new Error('Failed to create role');
    return mapRoleRow(row);
  }

  async getById(id: string): Promise<Role | null> {
    const result = await this.pool.query<RoleRow>(
      `SELECT * FROM roles WHERE id = $1`,
      [id]
    );
    const row = result.rows[0];
    return row ? mapRoleRow(row) : null;
  }

  async require(id: string): Promise<Role> {
    const role = await this.getById(id);
    if (!role) throw new NotFoundError('Role', id);
    return role;
  }

  /**
   * Get role by agent instance ID.
   * Joins agent_instances table to find the role for a given agent.
   */
  async getRoleByAgentId(agentId: string): Promise<Role | null> {
    const result = await this.pool.query<RoleRow>(
      `SELECT r.* FROM roles r
       JOIN agent_instances ai ON ai.role_id = r.id
       WHERE ai.id = $1`,
      [agentId]
    );
    const row = result.rows[0];
    return row ? mapRoleRow(row) : null;
  }

  async list(): Promise<Role[]> {
    const result = await this.pool.query<RoleRow>(
      `SELECT * FROM roles ORDER BY created_at DESC`
    );
    return result.rows.map(mapRoleRow);
  }

  async update(
    id: string,
    fields: Partial<CreateRole>
  ): Promise<Role> {
    await this.require(id);

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
    if (fields.system_prompt !== undefined) {
      sets.push(`system_prompt = $${idx++}`);
      params.push(fields.system_prompt);
    }
    if (fields.allowed_tools !== undefined) {
      sets.push(`allowed_tools = $${idx++}::jsonb`);
      params.push(JSON.stringify(fields.allowed_tools));
    }
    if (fields.denied_tools !== undefined) {
      sets.push(`denied_tools = $${idx++}::jsonb`);
      params.push(JSON.stringify(fields.denied_tools));
    }
    if (fields.style_constraints !== undefined) {
      sets.push(`style_constraints = $${idx++}::jsonb`);
      params.push(JSON.stringify(fields.style_constraints));
    }
    if (fields.is_lead !== undefined) {
      sets.push(`is_lead = $${idx++}`);
      params.push(fields.is_lead);
    }

    if (sets.length === 0) {
      return this.require(id);
    }

    sets.push('updated_at = NOW()');

    const result = await this.pool.query<RoleRow>(
      `UPDATE roles SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError('Role', id);
    return mapRoleRow(row);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM roles WHERE id = $1`,
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getStats(id: string): Promise<{
    group_count: number;
    groups: Array<{ id: string; name: string }>;
  }> {
    await this.require(id);
    const result = await this.pool.query<{ group_id: string; group_name: string }>(
      `SELECT DISTINCT g.id AS group_id, g.name AS group_name
       FROM group_members gm
       JOIN groups g ON g.id = gm.group_id
       WHERE gm.role_id = $1
       ORDER BY g.name ASC`,
      [id]
    );
    return {
      group_count: result.rows.length,
      groups: result.rows.map(row => ({ id: row.group_id, name: row.group_name })),
    };
  }
}




