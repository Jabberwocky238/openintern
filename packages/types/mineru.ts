import { z } from 'zod';

export const MineruModelVersionSchema = z.enum(['pipeline', 'vlm', 'MinerU-HTML']);
export type MineruModelVersion = z.infer<typeof MineruModelVersionSchema>;

export const MineruTaskStateSchema = z.enum([
  'pending',
  'running',
  'converting',
  'done',
  'failed',
]);
export type MineruTaskState = z.infer<typeof MineruTaskStateSchema>;

export const MineruExtractOptionsSchema = z.object({
  model_version: MineruModelVersionSchema.optional(),
  is_ocr: z.boolean().optional(),
  enable_formula: z.boolean().optional(),
  enable_table: z.boolean().optional(),
  language: z.string().min(1).max(32).optional(),
  page_ranges: z.string().min(1).max(256).optional(),
  no_cache: z.boolean().optional(),
  cache_tolerance: z.number().int().min(1).max(86400).optional(),
  data_id: z.string().min(1).max(128).optional(),
});
export type MineruExtractOptions = z.infer<typeof MineruExtractOptionsSchema>;
