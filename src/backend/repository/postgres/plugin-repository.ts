import type { Pool } from 'pg';
import type { IPluginRepository } from '../interfaces/plugin-repository.js';

// ─── Row types ───────────────────────────────────────────

export interface PluginRow {
  id: string;
  provider: string;
  org_id: string;
  project_id: string;
  name: string;
  status: 'active' | 'paused';
  config: Record<string, unknown>;
  state: Record<string, unknown>;
  created_by: string;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface PluginJobRow {
  id: string;
  plugin_id: string;
  org_id: string;
  project_id: string;
  kind: string;
  trigger: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  started_at: string | Date | null;
  ended_at: string | Date | null;
  result: Record<string, unknown>;
  error_message: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface PluginKvRow {
  plugin_id: string;
  key: string;
  value: Record<string, unknown>;
  updated_at: string | Date;
}

// ─── Repository ──────────────────────────────────────────

export class PluginRepository implements IPluginRepository {
  constructor(private readonly pool: Pool) {}

  // ── plugins CRUD ─────────────────────────────────────

  async createPlugin(input: {
    id: string;
    provider: string;
    orgId: string;
    projectId: string;
    name: string;
    status: 'active' | 'paused';
    config: Record<string, unknown>;
    createdBy: string;
  }): Promise<PluginRow> {
    const r = await this.pool.query<PluginRow>(
      `INSERT INTO plugins (id, provider, org_id, project_id, name, status, config, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING *`,
      [input.id, input.provider, input.orgId, input.projectId, input.name, input.status, JSON.stringify(input.config), input.createdBy],
    );
    return r.rows[0]!;
  }

  async getPlugin(id: string, provider: string): Promise<PluginRow | null> {
    const r = await this.pool.query<PluginRow>(
      `SELECT * FROM plugins WHERE id = $1 AND provider = $2 LIMIT 1`,
      [id, provider],
    );
    return r.rows[0] ?? null;
  }

  async getPluginScoped(id: string, provider: string, orgId: string, projectId: string): Promise<PluginRow | null> {
    const r = await this.pool.query<PluginRow>(
      `SELECT * FROM plugins WHERE id = $1 AND provider = $2 AND org_id = $3 AND project_id = $4 LIMIT 1`,
      [id, provider, orgId, projectId],
    );
    return r.rows[0] ?? null;
  }

  async listPlugins(provider: string, orgId: string, projectId: string): Promise<PluginRow[]> {
    const r = await this.pool.query<PluginRow>(
      `SELECT * FROM plugins WHERE provider = $1 AND org_id = $2 AND project_id = $3 ORDER BY created_at DESC`,
      [provider, orgId, projectId],
    );
    return r.rows;
  }

  async listActivePlugins(provider: string): Promise<PluginRow[]> {
    const r = await this.pool.query<PluginRow>(
      `SELECT * FROM plugins WHERE provider = $1 AND status = 'active'
       ORDER BY COALESCE((state->>'last_polled_at')::timestamptz, '1970-01-01'::timestamptz) ASC`,
      [provider],
    );
    return r.rows;
  }

  async updatePlugin(id: string, provider: string, orgId: string, projectId: string, patch: Record<string, unknown>): Promise<PluginRow | null> {
    const sets: string[] = [];
    const params: unknown[] = [id, provider, orgId, projectId];
    for (const [key, val] of Object.entries(patch)) {
      if (key === 'config' || key === 'state') {
        sets.push(`${key} = $${params.push(JSON.stringify(val))}::jsonb`);
      } else {
        sets.push(`${key} = $${params.push(val)}`);
      }
    }
    if (sets.length === 0) return this.getPluginScoped(id, provider, orgId, projectId);
    sets.push('updated_at = NOW()');
    const r = await this.pool.query<PluginRow>(
      `UPDATE plugins SET ${sets.join(', ')} WHERE id = $1 AND provider = $2 AND org_id = $3 AND project_id = $4 RETURNING *`,
      params,
    );
    return r.rows[0] ?? null;
  }

  async updatePluginState(id: string, statePatch: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `UPDATE plugins SET state = state || $2::jsonb, updated_at = NOW() WHERE id = $1`,
      [id, JSON.stringify(statePatch)],
    );
  }

  // ── plugin_jobs CRUD ─────────────────────────────────

  async createJob(input: {
    id: string;
    pluginId: string;
    orgId: string;
    projectId: string;
    kind: string;
    trigger: string;
    result?: Record<string, unknown>;
  }): Promise<PluginJobRow> {
    const r = await this.pool.query<PluginJobRow>(
      `INSERT INTO plugin_jobs (id, plugin_id, org_id, project_id, kind, trigger, status, result)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7::jsonb) RETURNING *`,
      [input.id, input.pluginId, input.orgId, input.projectId, input.kind, input.trigger, JSON.stringify(input.result ?? {})],
    );
    return r.rows[0]!;
  }

  async setJobRunning(jobId: string): Promise<void> {
    await this.pool.query(
      `UPDATE plugin_jobs SET status = 'running', started_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [jobId],
    );
  }

  async setJobCompleted(jobId: string, result: Record<string, unknown>): Promise<PluginJobRow> {
    const r = await this.pool.query<PluginJobRow>(
      `UPDATE plugin_jobs SET status = 'completed', result = $2::jsonb, ended_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`,
      [jobId, JSON.stringify(result)],
    );
    return r.rows[0]!;
  }

  async setJobFailed(jobId: string, result: Record<string, unknown>, errorMessage: string): Promise<PluginJobRow> {
    const r = await this.pool.query<PluginJobRow>(
      `UPDATE plugin_jobs SET status = 'failed', result = $2::jsonb, error_message = $3, ended_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`,
      [jobId, JSON.stringify(result), errorMessage],
    );
    return r.rows[0]!;
  }

  async listJobs(pluginId: string, orgId: string, projectId: string, limit: number): Promise<PluginJobRow[]> {
    const r = await this.pool.query<PluginJobRow>(
      `SELECT * FROM plugin_jobs WHERE plugin_id = $1 AND org_id = $2 AND project_id = $3 ORDER BY created_at DESC LIMIT $4`,
      [pluginId, orgId, projectId, limit],
    );
    return r.rows;
  }

  async getRunningJob(pluginId: string): Promise<PluginJobRow | null> {
    const r = await this.pool.query<PluginJobRow>(
      `SELECT * FROM plugin_jobs WHERE plugin_id = $1 AND status = 'running' ORDER BY created_at DESC LIMIT 1`,
      [pluginId],
    );
    return r.rows[0] ?? null;
  }

  // ── plugin_kv CRUD ───────────────────────────────────

  async getKv(pluginId: string, key: string): Promise<PluginKvRow | null> {
    const r = await this.pool.query<PluginKvRow>(
      `SELECT * FROM plugin_kv WHERE plugin_id = $1 AND key = $2 LIMIT 1`,
      [pluginId, key],
    );
    return r.rows[0] ?? null;
  }

  async upsertKv(pluginId: string, key: string, value: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `INSERT INTO plugin_kv (plugin_id, key, value) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (plugin_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [pluginId, key, JSON.stringify(value)],
    );
  }
}
