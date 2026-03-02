import { z } from 'zod';

/**
 * Run status enum
 */
export const RunStatusSchema = z.enum([
  'pending',
  'running',
  'waiting',
  'suspended',
  'completed',
  'failed',
  'cancelled',
]);

export type RunStatus = z.infer<typeof RunStatusSchema>;

/**
 * Run mode enum
 */
export const RunModeSchema = z.enum([
  'single',
  'group',
  'plan_execute',
]);

export type RunMode = z.infer<typeof RunModeSchema>;

/**
 * Run metadata schema - for fast UI loading
 */
export const RunMetaSchema = z.object({
  /** Run identifier */
  run_id: z.string().regex(/^run_[a-zA-Z0-9]+$/),
  /** Session key */
  session_key: z.string().regex(/^s_[a-zA-Z0-9_]+$/),
  /** Run status */
  status: RunStatusSchema,
  /** Execution mode for this run */
  run_mode: RunModeSchema.optional(),
  /** Run start timestamp */
  started_at: z.string().datetime(),
  /** Run end timestamp (null if still running) */
  ended_at: z.string().datetime().nullable(),
  /** Duration in milliseconds (null if still running) */
  duration_ms: z.number().nonnegative().nullable(),
  /** Total event count */
  event_count: z.number().nonnegative(),
  /** Tool call count */
  tool_call_count: z.number().nonnegative(),
  /** Parent run ID (null if top-level run) */
  parent_run_id: z.string().nullable().optional(),
});

export type RunMeta = z.infer<typeof RunMetaSchema>;
