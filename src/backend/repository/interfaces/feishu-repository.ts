import type {
  FeishuConnector,
  FeishuConnectorConfig,
  FeishuConnectorStatus,
  FeishuSyncJob,
  FeishuSyncStats,
  FeishuSyncTrigger,
} from '../../../types/feishu.js';

export interface FeishuScope {
  orgId: string;
  projectId: string;
}

export interface FeishuSourceStateView {
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

export interface CreateFeishuConnectorInput {
  orgId: string;
  projectId: string;
  createdBy: string;
  name: string;
  status: FeishuConnectorStatus;
  config: FeishuConnectorConfig;
}

export interface UpdateFeishuConnectorInput {
  name?: string;
  status?: FeishuConnectorStatus;
  config?: FeishuConnectorConfig;
}

export interface UpdateFeishuConnectorSyncResultInput {
  connectorId: string;
  success: boolean;
  errorMessage: string | null;
}

export interface CreateFeishuSyncJobInput {
  connectorId: string;
  orgId: string;
  projectId: string;
  trigger: FeishuSyncTrigger;
}

export interface UpsertFeishuSourceStateInput {
  connectorId: string;
  sourceKey: string;
  sourceType: 'docx' | 'bitable';
  sourceId: string;
  revisionId: string | null;
  contentHash: string;
  metadata: Record<string, unknown>;
  updatedAt: string | null;
}

export interface IFeishuRepository {
  createConnector(input: CreateFeishuConnectorInput): Promise<FeishuConnector>;
  listConnectors(scope: FeishuScope): Promise<FeishuConnector[]>;
  listActiveConnectors(): Promise<FeishuConnector[]>;
  getConnector(scope: FeishuScope, connectorId: string): Promise<FeishuConnector | null>;
  requireConnector(scope: FeishuScope, connectorId: string): Promise<FeishuConnector>;
  updateConnector(
    scope: FeishuScope,
    connectorId: string,
    patch: UpdateFeishuConnectorInput
  ): Promise<FeishuConnector>;
  touchConnectorPolledAt(connectorId: string): Promise<void>;
  updateConnectorSyncResult(input: UpdateFeishuConnectorSyncResultInput): Promise<void>;
  createSyncJob(input: CreateFeishuSyncJobInput): Promise<FeishuSyncJob>;
  setSyncJobRunning(jobId: string): Promise<void>;
  setSyncJobCompleted(jobId: string, stats: FeishuSyncStats): Promise<FeishuSyncJob>;
  setSyncJobFailed(jobId: string, stats: FeishuSyncStats, errorMessage: string): Promise<FeishuSyncJob>;
  listSyncJobs(scope: FeishuScope, connectorId: string, limit: number): Promise<FeishuSyncJob[]>;
  getRunningJob(connectorId: string): Promise<FeishuSyncJob | null>;
  getSourceState(connectorId: string, sourceKey: string): Promise<FeishuSourceStateView | null>;
  upsertSourceState(input: UpsertFeishuSourceStateInput): Promise<void>;
}
