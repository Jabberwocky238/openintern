import { z } from 'zod';

export const ScopeSchema = z.object({
  org_id: z.string().min(1),
  user_id: z.string().min(1),
  project_id: z.string().min(1).optional(),
});

export type Scope = z.infer<typeof ScopeSchema>;
