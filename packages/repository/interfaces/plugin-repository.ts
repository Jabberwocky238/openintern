export interface PluginRowView {
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

export interface PluginJobRowView {
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

export interface PluginKvRowView {
  plugin_id: string;
  key: string;
  value: Record<string, unknown>;
  updated_at: string | Date;
}

export interface CreatePluginInput {
  id: string;
  provider: string;
  orgId: string;
  projectId: string;
  name: string;
  status: 'active' | 'paused';
  config: Record<string, unknown>;
  createdBy: string;
}

export interface CreatePluginJobInput {
  id: string;
  pluginId: string;
  orgId: string;
  projectId: string;
  kind: string;
  trigger: string;
  result?: Record<string, unknown>;
}

export interface IPluginRepository {
  createPlugin(input: CreatePluginInput): Promise<PluginRowView>;
  getPlugin(id: string, provider: string): Promise<PluginRowView | null>;
  getPluginScoped(id: string, provider: string, orgId: string, projectId: string): Promise<PluginRowView | null>;
  listPlugins(provider: string, orgId: string, projectId: string): Promise<PluginRowView[]>;
  listActivePlugins(provider: string): Promise<PluginRowView[]>;
  updatePlugin(
    id: string,
    provider: string,
    orgId: string,
    projectId: string,
    patch: Record<string, unknown>
  ): Promise<PluginRowView | null>;
  updatePluginState(id: string, statePatch: Record<string, unknown>): Promise<void>;
  createJob(input: CreatePluginJobInput): Promise<PluginJobRowView>;
  setJobRunning(jobId: string): Promise<void>;
  setJobCompleted(jobId: string, result: Record<string, unknown>): Promise<PluginJobRowView>;
  setJobFailed(jobId: string, result: Record<string, unknown>, errorMessage: string): Promise<PluginJobRowView>;
  listJobs(pluginId: string, orgId: string, projectId: string, limit: number): Promise<PluginJobRowView[]>;
  getRunningJob(pluginId: string): Promise<PluginJobRowView | null>;
  getKv(pluginId: string, key: string): Promise<PluginKvRowView | null>;
  upsertKv(pluginId: string, key: string, value: Record<string, unknown>): Promise<void>;
}


