import { z } from 'zod';

/**
 * Embedding provider configuration schema
 */
export const EmbeddingConfigSchema = z.object({
  /** Provider type: 'hash' (zero-dep) or 'api' (high quality) */
  provider: z.enum(['hash', 'api']).default('hash'),
  /** Embedding vector dimension */
  dimension: z.number().positive().default(256),
  /** Hybrid search alpha: weight for vector score vs keyword score */
  alpha: z.number().min(0).max(1).default(0.6),
  /** API endpoint for 'api' provider */
  apiUrl: z.string().optional(),
  /** API model name for 'api' provider */
  apiModel: z.string().optional(),
});

export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;
