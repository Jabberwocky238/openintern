import { z } from 'zod';
import { RunMetaSchema, RunStatusSchema, RunModeSchema } from './run.js';
import { EventSchema } from './events.js';
import { AttachmentReferenceSchema } from './upload.js';

/**
 * LLM config schema for API requests
 */
export const LLMConfigRequestSchema = z.object({
  provider: z.enum(['openai', 'anthropic', 'gemini', 'mock']).optional(),
  model: z.string().min(1).optional(),
  base_url: z.string().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().positive().optional(),
}).optional();

export type LLMConfigRequest = z.infer<typeof LLMConfigRequestSchema>;

/**
 * Create run request schema
 */
export const CreateRunRequestSchema = z.object({
  org_id: z.string().min(1).optional(),
  user_id: z.string().min(1).optional(),
  project_id: z.string().min(1).optional(),
  session_key: z.string().regex(/^s_[a-zA-Z0-9_]+$/).optional(),
  input: z.string().min(1),
  agent_id: z.string().min(1).optional(),
  run_mode: RunModeSchema.optional(),
  llm_config: LLMConfigRequestSchema,
  attachments: z.array(AttachmentReferenceSchema).max(5).optional(),
});

export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;

/**
 * Create run response schema
 */
export const CreateRunResponseSchema = z.object({
  run_id: z.string().regex(/^run_[a-zA-Z0-9]+$/),
  status: RunStatusSchema,
  created_at: z.string().datetime(),
});

export type CreateRunResponse = z.infer<typeof CreateRunResponseSchema>;

/**
 * List runs response schema
 */
export const ListRunsResponseSchema = z.object({
  runs: z.array(RunMetaSchema),
  total: z.number().nonnegative(),
  page: z.number().positive(),
  limit: z.number().positive(),
});

export type ListRunsResponse = z.infer<typeof ListRunsResponseSchema>;

/**
 * Get run events response schema
 */
export const GetRunEventsResponseSchema = z.object({
  events: z.array(EventSchema),
  total: z.number().nonnegative(),
  next_cursor: z.string().nullable().optional(),
});

export type GetRunEventsResponse = z.infer<typeof GetRunEventsResponseSchema>;

/**
 * Error response schema
 */
export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
  }),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/**
 * Queued run schema - for internal queue management
 */
export const QueuedRunSchema = z.object({
  run_id: z.string().regex(/^run_[a-zA-Z0-9]+$/),
  org_id: z.string().min(1),
  user_id: z.string().min(1),
  project_id: z.string().optional(),
  session_key: z.string().regex(/^s_[a-zA-Z0-9_]+$/),
  input: z.string(),
  agent_id: z.string(),
  run_mode: RunModeSchema.optional(),
  created_at: z.string().datetime(),
  status: z.enum(['pending', 'running', 'waiting', 'suspended', 'completed', 'failed', 'cancelled']),
  llm_config: LLMConfigRequestSchema,
  group_id: z.string().min(1).optional(),
  parent_run_id: z.string().min(1).optional(),
  attachments: z.array(AttachmentReferenceSchema).optional(),
});

export type QueuedRun = z.infer<typeof QueuedRunSchema>;

/**
 * SSE event types
 */
export type SSEEventType = 'run.event' | 'ping' | 'connected';

/**
 * SSE message format
 */
export interface SSEMessage {
  event: SSEEventType;
  data: unknown;
  id?: string;
}
