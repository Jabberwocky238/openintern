import { z } from 'zod';

/**
 * Memory item schema - for storing memory items
 */
export const MemoryItemSchema = z.object({
  /** Memory item identifier */
  id: z.string().regex(/^mem_[a-zA-Z0-9]+$/),
  /** Creation timestamp */
  created_at: z.string().datetime(),
  /** Last updated timestamp */
  updated_at: z.string().datetime(),
  /** Memory content */
  content: z.string(),
  /** Keywords for search */
  keywords: z.array(z.string()),
  /** Optional metadata */
  metadata: z.record(z.unknown()).optional(),
});

export type MemoryItem = z.infer<typeof MemoryItemSchema>;

/**
 * Memory layers persisted in Postgres.
 * Working memory is stored in checkpoint state and not persisted in memories table.
 */
export const MemoryTypeSchema = z.enum(['core', 'episodic', 'archival']);
export type MemoryType = z.infer<typeof MemoryTypeSchema>;

export const MemoryScopeSchema = z.object({
  org_id: z.string().min(1),
  user_id: z.string().min(1),
  project_id: z.string().min(1).optional(),
  group_id: z.string().min(1).optional(),
  agent_instance_id: z.string().min(1).optional(),
});
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

export const MemorySearchRequestSchema = z.object({
  query: z.string().min(1),
  top_k: z.number().int().positive().max(50).default(8),
  scope: MemoryScopeSchema,
  filters: z.record(z.unknown()).optional(),
});
export type MemorySearchRequest = z.infer<typeof MemorySearchRequestSchema>;

export const MemorySearchResultSchema = z.object({
  id: z.string().uuid(),
  snippet: z.string(),
  score: z.number(),
  type: MemoryTypeSchema,
});
export type MemorySearchResult = z.infer<typeof MemorySearchResultSchema>;

export const MemoryWriteRequestSchema = z.object({
  type: MemoryTypeSchema,
  scope: MemoryScopeSchema,
  text: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
  importance: z.number().min(0).max(1).optional(),
});
export type MemoryWriteRequest = z.infer<typeof MemoryWriteRequestSchema>;

export const MemoryGetResponseSchema = z.object({
  id: z.string().uuid(),
  type: MemoryTypeSchema,
  text: z.string(),
  metadata: z.record(z.unknown()),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type MemoryGetResponse = z.infer<typeof MemoryGetResponseSchema>;

export const BlackboardWriteRequestSchema = z.object({
  type: MemoryTypeSchema,
  scope: MemoryScopeSchema,
  group_id: z.string().min(1),
  text: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
  importance: z.number().min(0).max(1).optional(),
  role_id: z.string().min(1),
  is_lead: z.boolean(),
});
export type BlackboardWriteRequest = z.infer<typeof BlackboardWriteRequestSchema>;

export const TieredSearchInputSchema = z.object({
  query: z.string().min(1),
  top_k: z.number().int().positive().max(50).default(8),
  scope: MemoryScopeSchema,
  group_id: z.string().min(1).optional(),
  agent_instance_id: z.string().min(1).optional(),
});
export type TieredSearchInput = z.infer<typeof TieredSearchInputSchema>;
