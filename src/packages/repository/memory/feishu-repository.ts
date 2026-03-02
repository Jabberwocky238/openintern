import type {
  FeishuConnector,
  FeishuConnectorConfig,
  FeishuConnectorStatus,
  FeishuSyncJob,
  FeishuSyncStats,
  FeishuSyncTrigger,
} from '../../../types/feishu.js';
import { NotFoundError } from '@openintern/utils';
import { generatePluginId, generatePluginJobId } from '@openintern/utils';
import type { IFeishuRepository } from '../interfaces/feishu-repository.js';
import type { PluginJobRow, PluginKvRow, PluginRow } from './plugin-repository.js';
import { PluginRepository } from './plugin-repository.js';

const PROVIDER = 'feishu';

export interface FeishuSourceState {
  connector_id: string;
  source_key: string;
  source_type: 'docx' | 'bitable';
  source_id: string;
  revision_id: string | null;
  content_hash: string | null;
  metadata: Record<string, unknown>;
  updated_at: string | null;
  last_synced_at: string;
}

const DEFAULT_STATS: FeishuSyncStats = {
  discovered: 0,
  processed: 0,
  skipped: 0,
  failed: 0,
  docx_docs: 0,
  bitable_tables: 0,
  chunk_count: 0,
};

function toIso(value: string | Date | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapPluginToConnector(row: PluginRow): FeishuConnector {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    name: row.name,
    status: row.status as FeishuConnectorStatus,
    config: row.config as FeishuConnectorConfig,
    created_by: row.created_by,
    last_sync_at: toIso(row.state.last_sync_at as string | null),
    last_success_at: toIso(row.state.last_success_at as string | null),
    last_error: (row.state.last_error as string) ?? null,
    last_polled_at: toIso(row.state.last_polled_at as string | null),
    created_at: toIso(row.created_at) ?? new Date().toISOString(),
    updated_at: toIso(row.updated_at) ?? new Date().toISOString(),
  };
}

function mapJobToSyncJob(row: PluginJobRow): FeishuSyncJob {
  const result = row.result;
  return {
    id: row.id,
    connector_id: row.plugin_id,
    org_id: row.org_id,
    project_id: row.project_id,
    trigger: row.trigger as FeishuSyncTrigger,
    status: row.status,
    started_at: toIso(row.started_at),
    ended_at: toIso(row.ended_at),
    stats: (result.stats ?? result) as FeishuSyncStats,
    error_message: row.error_message,
    created_at: toIso(row.created_at) ?? new Date().toISOString(),
    updated_at: toIso(row.updated_at) ?? new Date().toISOString(),
  };
}

function mapKvToState(row: PluginKvRow): FeishuSourceState {
  const value = row.value;
  return {
    connector_id: row.plugin_id,
    source_key: row.key,
    source_type: value.source_type as 'docx' | 'bitable',
    source_id: value.source_id as string,
    revision_id: (value.revision_id as string) ?? null,
    content_hash: (value.content_hash as string) ?? null,
    metadata: (value.metadata as Record<string, unknown>) ?? {},
    updated_at: toIso(value.updated_at as string | null),
    last_synced_at: toIso(row.updated_at) ?? new Date().toISOString(),
  };
}

export class FeishuRepository implements IFeishuRepository {
  constructor(private readonly repo: PluginRepository) {}

  async createConnector(input: {
    orgId: string;
    projectId: string;
    createdBy: string;
    name: string;
    status: FeishuConnectorStatus;
    config: FeishuConnectorConfig;
  }): Promise<FeishuConnector> {
    const row = await this.repo.createPlugin({
      id: generatePluginId(),
      provider: PROVIDER,
      orgId: input.orgId,
      projectId: input.projectId,
      name: input.name,
      status: input.status,
      config: input.config as Record<string, unknown>,
      createdBy: input.createdBy,
    });
    return mapPluginToConnector(row);
  }

  async listConnectors(scope: { orgId: string; projectId: string }): Promise<FeishuConnector[]> {
    const rows = await this.repo.listPlugins(PROVIDER, scope.orgId, scope.projectId);
    return rows.map(mapPluginToConnector);
  }

  async listActiveConnectors(): Promise<FeishuConnector[]> {
    const rows = await this.repo.listActivePlugins(PROVIDER);
    return rows.map(mapPluginToConnector);
  }

  async getConnector(scope: { orgId: string; projectId: string }, connectorId: string): Promise<FeishuConnector | null> {
    const row = await this.repo.getPluginScoped(connectorId, PROVIDER, scope.orgId, scope.projectId);
    return row ? mapPluginToConnector(row) : null;
  }

  async requireConnector(scope: { orgId: string; projectId: string }, connectorId: string): Promise<FeishuConnector> {
    const connector = await this.getConnector(scope, connectorId);
    if (!connector) {
      throw new NotFoundError('Feishu connector', connectorId);
    }
    return connector;
  }

  async updateConnector(
    scope: { orgId: string; projectId: string },
    connectorId: string,
    patch: { name?: string; status?: FeishuConnectorStatus; config?: FeishuConnectorConfig }
  ): Promise<FeishuConnector> {
    const updates: Record<string, unknown> = {};
    if (patch.name !== undefined) {
      updates.name = patch.name;
    }
    if (patch.status !== undefined) {
      updates.status = patch.status;
    }
    if (patch.config !== undefined) {
      updates.config = patch.config;
    }
    if (Object.keys(updates).length === 0) {
      return this.requireConnector(scope, connectorId);
    }
    const row = await this.repo.updatePlugin(connectorId, PROVIDER, scope.orgId, scope.projectId, updates);
    if (!row) {
      throw new NotFoundError('Feishu connector', connectorId);
    }
    return mapPluginToConnector(row);
  }

  async touchConnectorPolledAt(connectorId: string): Promise<void> {
    await this.repo.updatePluginState(connectorId, { last_polled_at: new Date().toISOString() });
  }

  async updateConnectorSyncResult(input: { connectorId: string; success: boolean; errorMessage: string | null }): Promise<void> {
    const now = new Date().toISOString();
    if (input.success) {
      await this.repo.updatePluginState(input.connectorId, {
        last_sync_at: now,
        last_success_at: now,
        last_error: null,
      });
      return;
    }
    await this.repo.updatePluginState(input.connectorId, {
      last_sync_at: now,
      last_error: input.errorMessage,
    });
  }

  async createSyncJob(input: {
    connectorId: string;
    orgId: string;
    projectId: string;
    trigger: FeishuSyncTrigger;
  }): Promise<FeishuSyncJob> {
    const row = await this.repo.createJob({
      id: generatePluginJobId(),
      pluginId: input.connectorId,
      orgId: input.orgId,
      projectId: input.projectId,
      kind: 'sync',
      trigger: input.trigger,
      result: { stats: DEFAULT_STATS },
    });
    return mapJobToSyncJob(row);
  }

  async setSyncJobRunning(jobId: string): Promise<void> {
    await this.repo.setJobRunning(jobId);
  }

  async setSyncJobCompleted(jobId: string, stats: FeishuSyncStats): Promise<FeishuSyncJob> {
    const row = await this.repo.setJobCompleted(jobId, { stats });
    return mapJobToSyncJob(row);
  }

  async setSyncJobFailed(jobId: string, stats: FeishuSyncStats, errorMessage: string): Promise<FeishuSyncJob> {
    const row = await this.repo.setJobFailed(jobId, { stats }, errorMessage);
    return mapJobToSyncJob(row);
  }

  async listSyncJobs(scope: { orgId: string; projectId: string }, connectorId: string, limit: number): Promise<FeishuSyncJob[]> {
    const rows = await this.repo.listJobs(connectorId, scope.orgId, scope.projectId, limit);
    return rows.map(mapJobToSyncJob);
  }

  async getRunningJob(connectorId: string): Promise<FeishuSyncJob | null> {
    const row = await this.repo.getRunningJob(connectorId);
    return row ? mapJobToSyncJob(row) : null;
  }

  async getSourceState(connectorId: string, sourceKey: string): Promise<FeishuSourceState | null> {
    const row = await this.repo.getKv(connectorId, sourceKey);
    return row ? mapKvToState(row) : null;
  }

  async upsertSourceState(input: {
    connectorId: string;
    sourceKey: string;
    sourceType: 'docx' | 'bitable';
    sourceId: string;
    revisionId: string | null;
    contentHash: string;
    metadata: Record<string, unknown>;
    updatedAt: string | null;
  }): Promise<void> {
    await this.repo.upsertKv(input.connectorId, input.sourceKey, {
      source_type: input.sourceType,
      source_id: input.sourceId,
      revision_id: input.revisionId,
      content_hash: input.contentHash,
      metadata: input.metadata,
      updated_at: input.updatedAt,
    });
  }
}


