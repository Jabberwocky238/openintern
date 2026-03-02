import type { PlanRecord, PlanTaskRecord } from '../../../backend/runtime/models.js';

export interface CreatePlanTaskInput {
  taskId: string;
  task: string;
  roleId: string;
  dependsOn: string[];
  layerIndex: number;
  context?: string;
  acceptance?: string;
}

export interface CreatePlanInput {
  runId: string;
  plannerModel: string;
  rawPlan: Record<string, unknown>;
  tasks: CreatePlanTaskInput[];
}

export interface TaskDispatchInput {
  taskId: string;
  childRunId: string;
  toolCallId: string;
}

export interface IPlanRepository {
  getPlanByRunId(runId: string): Promise<PlanRecord | null>;
  listTasksByRunId(runId: string): Promise<PlanTaskRecord[]>;
  createPlan(input: CreatePlanInput): Promise<{ plan: PlanRecord; tasks: PlanTaskRecord[] }>;
  markPlanStatus(runId: string, status: PlanRecord['status'], failureReason?: string): Promise<void>;
  syncTaskStatusFromDependencies(runId: string): Promise<PlanTaskRecord[]>;
  listReadyTasksByRunId(runId: string): Promise<PlanTaskRecord[]>;
  markTasksRunning(runId: string, dispatches: TaskDispatchInput[]): Promise<void>;
}

