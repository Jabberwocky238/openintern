import type { Pool } from 'pg';
import type { Skill, CreateSkill } from '../../../types/skill.js';
import { generateSkillId } from '../../../utils/ids.js';
import { NotFoundError } from '../../../utils/errors.js';
import type { ISkillRepository } from '../interfaces/skill-repository.js';

interface SkillRow {
  id: string;
  name: string;
  description: string;
  tools: unknown[];
  risk_level: string;
  provider: string;
  health_status: string;
  allow_implicit_invocation?: boolean | null;
  created_at: string | Date;
  updated_at: string | Date;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapSkillRow(row: SkillRow): Skill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    tools: row.tools as Skill['tools'],
    risk_level: row.risk_level as Skill['risk_level'],
    provider: row.provider as Skill['provider'],
    health_status: row.health_status as Skill['health_status'],
    allow_implicit_invocation: row.allow_implicit_invocation ?? false,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

export class SkillRepository implements ISkillRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateSkill): Promise<Skill> {
    const id = generateSkillId();
    const result = await this.pool.query<SkillRow>(
      `INSERT INTO skills (id, name, description, tools, risk_level, provider)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       RETURNING *`,
      [
        id,
        input.name,
        input.description ?? '',
        JSON.stringify(input.tools ?? []),
        input.risk_level ?? 'low',
        input.provider ?? 'builtin',
      ]
    );
    const row = result.rows[0];
    if (!row) throw new Error('Failed to create skill');
    return mapSkillRow(row);
  }

  async getById(id: string): Promise<Skill | null> {
    const result = await this.pool.query<SkillRow>(
      `SELECT * FROM skills WHERE id = $1`,
      [id]
    );
    const row = result.rows[0];
    return row ? mapSkillRow(row) : null;
  }

  async require(id: string): Promise<Skill> {
    const skill = await this.getById(id);
    if (!skill) throw new NotFoundError('Skill', id);
    return skill;
  }

  async list(): Promise<Skill[]> {
    const result = await this.pool.query<SkillRow>(
      `SELECT * FROM skills ORDER BY created_at DESC`
    );
    return result.rows.map(mapSkillRow);
  }

  async updateHealthStatus(id: string, status: Skill['health_status']): Promise<Skill> {
    const result = await this.pool.query<SkillRow>(
      `UPDATE skills SET health_status = $2, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id, status]
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError('Skill', id);
    return mapSkillRow(row);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM skills WHERE id = $1`,
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }
}
