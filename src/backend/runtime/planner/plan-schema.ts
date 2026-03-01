import { z } from 'zod';

export const PlannerTaskSchema = z.object({
  id: z.string().min(1),
  task: z.string().min(1),
  role_id: z.string().min(1),
  depends_on: z.array(z.string().min(1)).default([]),
  context: z.string().optional(),
  acceptance: z.string().optional(),
});

export const PlannerOutputSchema = z.object({
  tasks: z.array(PlannerTaskSchema).min(1),
});

export type PlannerTask = z.infer<typeof PlannerTaskSchema>;
export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

export interface NormalizedPlannerTask {
  id: string;
  task: string;
  roleId: string;
  dependsOn: string[];
  context?: string;
  acceptance?: string;
  layerIndex: number;
}

