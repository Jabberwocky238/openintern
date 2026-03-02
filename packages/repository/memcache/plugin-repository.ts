import type {
  CreatePluginInput,
  CreatePluginJobInput,
  IPluginRepository,
  PluginJobRowView,
  PluginKvRowView,
  PluginRowView,
} from '../interfaces/plugin-repository.js';
import { clone, nowIso } from './helpers.js';
import { resolveMemoryRepositoryStore, type MemoryRepositoryStore } from './store.js';

export type PluginRow = PluginRowView;
export type PluginJobRow = PluginJobRowView;
export type PluginKvRow = PluginKvRowView;

function pluginKey(id: string, provider: string): string {
  return `${id}::${provider}`;
}

function kvKey(pluginId: string, key: string): string {
  return `${pluginId}::${key}`;
}

function polledAtMs(state: Record<string, unknown>): number {
  const value = state.last_polled_at;
  if (typeof value !== 'string') {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export class PluginRepository implements IPluginRepository {
  private readonly store: MemoryRepositoryStore;

  constructor(storeOrPool?: unknown) {
    this.store = resolveMemoryRepositoryStore(storeOrPool);
  }

  async createPlugin(input: CreatePluginInput): Promise<PluginRow> {
    const now = nowIso();
    const row: PluginRow = {
      id: input.id,
      provider: input.provider,
      org_id: input.orgId,
      project_id: input.projectId,
      name: input.name,
      status: input.status,
      config: clone(input.config),
      state: {},
      created_by: input.createdBy,
      created_at: now,
      updated_at: now,
    };
    this.store.plugins.set(pluginKey(row.id, row.provider), clone(row));
    return clone(row);
  }

  async getPlugin(id: string, provider: string): Promise<PluginRow | null> {
    const row = this.store.plugins.get(pluginKey(id, provider));
    return row ? clone(row) : null;
  }

  async getPluginScoped(id: string, provider: string, orgId: string, projectId: string): Promise<PluginRow | null> {
    const row = await this.getPlugin(id, provider);
    if (!row) {
      return null;
    }
    return row.org_id === orgId && row.project_id === projectId ? row : null;
  }

  async listPlugins(provider: string, orgId: string, projectId: string): Promise<PluginRow[]> {
    return [...this.store.plugins.values()]
      .filter((row) => row.provider === provider && row.org_id === orgId && row.project_id === projectId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .map((row) => clone(row));
  }

  async listActivePlugins(provider: string): Promise<PluginRow[]> {
    return [...this.store.plugins.values()]
      .filter((row) => row.provider === provider && row.status === 'active')
      .sort((a, b) => polledAtMs(a.state) - polledAtMs(b.state))
      .map((row) => clone(row));
  }

  async updatePlugin(
    id: string,
    provider: string,
    orgId: string,
    projectId: string,
    patch: Record<string, unknown>
  ): Promise<PluginRow | null> {
    const key = pluginKey(id, provider);
    const current = this.store.plugins.get(key);
    if (!current || current.org_id !== orgId || current.project_id !== projectId) {
      return null;
    }
    if (Object.keys(patch).length === 0) {
      return clone(current);
    }
    const next: PluginRow = {
      ...current,
      ...patch,
      updated_at: nowIso(),
    } as PluginRow;
    this.store.plugins.set(key, clone(next));
    return clone(next);
  }

  async updatePluginState(id: string, statePatch: Record<string, unknown>): Promise<void> {
    for (const [key, plugin] of this.store.plugins.entries()) {
      if (plugin.id !== id) {
        continue;
      }
      this.store.plugins.set(key, {
        ...plugin,
        state: { ...plugin.state, ...clone(statePatch) },
        updated_at: nowIso(),
      });
    }
  }

  async createJob(input: CreatePluginJobInput): Promise<PluginJobRow> {
    const now = nowIso();
    const row: PluginJobRow = {
      id: input.id,
      plugin_id: input.pluginId,
      org_id: input.orgId,
      project_id: input.projectId,
      kind: input.kind,
      trigger: input.trigger,
      status: 'pending',
      started_at: null,
      ended_at: null,
      result: clone(input.result ?? {}),
      error_message: null,
      created_at: now,
      updated_at: now,
    };
    this.store.pluginJobs.set(row.id, clone(row));
    return clone(row);
  }

  async setJobRunning(jobId: string): Promise<void> {
    const job = this.store.pluginJobs.get(jobId);
    if (!job) {
      return;
    }
    this.store.pluginJobs.set(jobId, {
      ...job,
      status: 'running',
      started_at: nowIso(),
      updated_at: nowIso(),
    });
  }

  async setJobCompleted(jobId: string, result: Record<string, unknown>): Promise<PluginJobRow> {
    const current = this.store.pluginJobs.get(jobId);
    if (!current) {
      throw new Error(`Plugin job not found: ${jobId}`);
    }
    const next: PluginJobRow = {
      ...current,
      status: 'completed',
      result: clone(result),
      ended_at: nowIso(),
      updated_at: nowIso(),
    };
    this.store.pluginJobs.set(jobId, clone(next));
    return clone(next);
  }

  async setJobFailed(jobId: string, result: Record<string, unknown>, errorMessage: string): Promise<PluginJobRow> {
    const current = this.store.pluginJobs.get(jobId);
    if (!current) {
      throw new Error(`Plugin job not found: ${jobId}`);
    }
    const next: PluginJobRow = {
      ...current,
      status: 'failed',
      result: clone(result),
      error_message: errorMessage,
      ended_at: nowIso(),
      updated_at: nowIso(),
    };
    this.store.pluginJobs.set(jobId, clone(next));
    return clone(next);
  }

  async listJobs(pluginId: string, orgId: string, projectId: string, limit: number): Promise<PluginJobRow[]> {
    return [...this.store.pluginJobs.values()]
      .filter((job) => job.plugin_id === pluginId && job.org_id === orgId && job.project_id === projectId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, limit)
      .map((job) => clone(job));
  }

  async getRunningJob(pluginId: string): Promise<PluginJobRow | null> {
    const running = [...this.store.pluginJobs.values()]
      .filter((job) => job.plugin_id === pluginId && job.status === 'running')
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
    return running ? clone(running) : null;
  }

  async getKv(pluginId: string, key: string): Promise<PluginKvRow | null> {
    const row = this.store.pluginKv.get(kvKey(pluginId, key));
    return row ? clone(row) : null;
  }

  async upsertKv(pluginId: string, key: string, value: Record<string, unknown>): Promise<void> {
    this.store.pluginKv.set(kvKey(pluginId, key), {
      plugin_id: pluginId,
      key,
      value: clone(value),
      updated_at: nowIso(),
    });
  }
}


