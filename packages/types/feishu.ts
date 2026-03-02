import { z } from 'zod';

export const FeishuConnectorStatusSchema = z.enum(['active', 'paused']);
export type FeishuConnectorStatus = z.infer<typeof FeishuConnectorStatusSchema>;

export const FeishuChunkingConfigSchema = z.object({
  target_tokens: z.number().int().min(120).max(2000).default(600),
  max_tokens: z.number().int().min(240).max(4000).default(1100),
  min_tokens: z.number().int().min(40).max(1200).default(120),
  media_context_blocks: z.number().int().min(0).max(4).default(2),
});
export type FeishuChunkingConfig = z.infer<typeof FeishuChunkingConfigSchema>;

export const FeishuConnectorConfigSchema = z.object({
  folder_tokens: z.array(z.string().min(1)).default([]),
  wiki_node_tokens: z.array(z.string().min(1)).default([]),
  file_tokens: z.array(z.string().min(1)).default([]),
  bitable_app_tokens: z.array(z.string().min(1)).default([]),
  poll_interval_seconds: z.number().int().min(60).max(86400).default(300),
  max_docs_per_sync: z.number().int().min(1).max(1000).default(200),
  max_records_per_table: z.number().int().min(1).max(5000).default(500),
  chunking: FeishuChunkingConfigSchema.default({
    target_tokens: 600,
    max_tokens: 1100,
    min_tokens: 120,
    media_context_blocks: 2,
  }),
});
export type FeishuConnectorConfig = z.infer<typeof FeishuConnectorConfigSchema>;

export const FeishuConnectorSchema = z.object({
  id: z.string().min(1),
  org_id: z.string().min(1),
  project_id: z.string().min(1),
  name: z.string().min(1),
  status: FeishuConnectorStatusSchema,
  config: FeishuConnectorConfigSchema,
  created_by: z.string().min(1),
  last_sync_at: z.string().datetime().nullable(),
  last_success_at: z.string().datetime().nullable(),
  last_error: z.string().nullable(),
  last_polled_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type FeishuConnector = z.infer<typeof FeishuConnectorSchema>;

export const CreateFeishuConnectorRequestSchema = z.object({
  name: z.string().min(1),
  status: FeishuConnectorStatusSchema.optional(),
  config: FeishuConnectorConfigSchema,
});
export type CreateFeishuConnectorRequest = z.infer<typeof CreateFeishuConnectorRequestSchema>;

export const UpdateFeishuConnectorRequestSchema = z.object({
  name: z.string().min(1).optional(),
  status: FeishuConnectorStatusSchema.optional(),
  config: FeishuConnectorConfigSchema.optional(),
});
export type UpdateFeishuConnectorRequest = z.infer<typeof UpdateFeishuConnectorRequestSchema>;

export const FeishuSyncTriggerSchema = z.enum(['manual', 'poll']);
export type FeishuSyncTrigger = z.infer<typeof FeishuSyncTriggerSchema>;

export const FeishuSyncJobStatusSchema = z.enum(['pending', 'running', 'completed', 'failed']);
export type FeishuSyncJobStatus = z.infer<typeof FeishuSyncJobStatusSchema>;

export const FeishuSyncStatsSchema = z.object({
  discovered: z.number().int().nonnegative().default(0),
  processed: z.number().int().nonnegative().default(0),
  skipped: z.number().int().nonnegative().default(0),
  failed: z.number().int().nonnegative().default(0),
  docx_docs: z.number().int().nonnegative().default(0),
  bitable_tables: z.number().int().nonnegative().default(0),
  chunk_count: z.number().int().nonnegative().default(0),
});
export type FeishuSyncStats = z.infer<typeof FeishuSyncStatsSchema>;

export const FeishuSyncJobSchema = z.object({
  id: z.string().min(1),
  connector_id: z.string().min(1),
  org_id: z.string().min(1),
  project_id: z.string().min(1),
  trigger: FeishuSyncTriggerSchema,
  status: FeishuSyncJobStatusSchema,
  started_at: z.string().datetime().nullable(),
  ended_at: z.string().datetime().nullable(),
  stats: FeishuSyncStatsSchema,
  error_message: z.string().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type FeishuSyncJob = z.infer<typeof FeishuSyncJobSchema>;

export const TriggerFeishuSyncRequestSchema = z.object({
  wait: z.boolean().default(true),
});
export type TriggerFeishuSyncRequest = z.infer<typeof TriggerFeishuSyncRequestSchema>;
