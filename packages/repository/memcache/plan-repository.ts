import type { PlanRecord, PlanTaskRecord } from '../../../src/backend/runtime/models.js';
import type { CreatePlanInput, IPlanRepository, TaskDispatchInput } from '../interfaces/plan-repository.js';
import { clone, nowIso } from './helpers.js';
import { resolveMemoryRepositoryStore, type MemoryRepositoryStore } from './store.js';

function touchPlan(plan: PlanRecord): PlanRecord {
  return { ...plan, updatedAt: nowIso() };
}

export class PlanRepository implements IPlanRepository {
  private readonly store: MemoryRepositoryStore;

  constructor(storeOrPool?: unknown) {
    this.store = resolveMemoryRepositoryStore(storeOrPool);
  }

  async getPlanByRunId(runId: string): Promise<PlanRecord | null> {
    const plan = this.store.plansByRunId.get(runId);
    return plan ? clone(plan) : null;
  }

  async listTasksByRunId(runId: string): Promise<PlanTaskRecord[]> {
    const tasks = this.store.planTasksByRunId.get(runId) ?? [];
    return tasks
      .slice()
      .sort((a, b) => (a.layerIndex - b.layerIndex) || (a.id - b.id))
      .map((task) => clone(task));
  }

  async createPlan(input: CreatePlanInput): Promise<{ plan: PlanRecord; tasks: PlanTaskRecord[] }> {
    if (input.tasks.length === 0) {
      throw new Error('Planner produced empty tasks');
    }
    const now = nowIso();
    const plan: PlanRecord = {
      id: this.store.nextPlanId++,
      runId: input.runId,
      plannerModel: input.plannerModel,
      status: 'planned',
      rawPlan: clone(input.rawPlan),
      failureReason: null,
      createdAt: now,
      updatedAt: now,
    };
    const tasks: PlanTaskRecord[] = input.tasks.map((task) => ({
      id: this.store.nextPlanTaskId++,
      planId: plan.id,
      runId: input.runId,
      taskId: task.taskId,
      task: task.task,
      roleId: task.roleId,
      dependsOn: clone(task.dependsOn),
      layerIndex: task.layerIndex,
      status: 'planned',
      context: task.context ?? null,
      acceptance: task.acceptance ?? null,
      childRunId: null,
      toolCallId: null,
      output: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    }));
    this.store.plansByRunId.set(input.runId, clone(plan));
    this.store.planTasksByRunId.set(input.runId, clone(tasks));
    return { plan: clone(plan), tasks: clone(tasks) };
  }

  async markPlanStatus(runId: string, status: PlanRecord['status'], failureReason?: string): Promise<void> {
    const current = this.store.plansByRunId.get(runId);
    if (!current) {
      return;
    }
    this.store.plansByRunId.set(
      runId,
      touchPlan({
        ...current,
        status,
        failureReason: failureReason ?? null,
      })
    );
  }

  async syncTaskStatusFromDependencies(runId: string): Promise<PlanTaskRecord[]> {
    const tasks = this.store.planTasksByRunId.get(runId) ?? [];
    const changed: PlanTaskRecord[] = [];
    for (let index = 0; index < tasks.length; index += 1) {
      const task = tasks[index];
      if (!task || task.status !== 'running' || !task.childRunId) {
        continue;
      }
      const dep = this.store.runDependencies.find((item) => item.childRunId === task.childRunId);
      if (!dep || dep.status === 'pending') {
        continue;
      }
      const next: PlanTaskRecord = {
        ...task,
        status: dep.status === 'completed' ? 'completed' : 'failed',
        output: dep.status === 'completed' ? (dep.result ?? task.output) : task.output,
        error: dep.status === 'failed' ? (dep.error ?? task.error) : task.error,
        updatedAt: nowIso(),
      };
      tasks[index] = next;
      changed.push(clone(next));
    }
    if (changed.length > 0) {
      this.store.planTasksByRunId.set(runId, tasks);
    }
    return changed;
  }

  async listReadyTasksByRunId(runId: string): Promise<PlanTaskRecord[]> {
    const tasks = this.store.planTasksByRunId.get(runId) ?? [];
    const byTaskId = new Map(tasks.map((task) => [task.taskId, task]));
    const ready = tasks.filter((task) => {
      if (task.status !== 'planned') {
        return false;
      }
      return task.dependsOn.every((depId) => byTaskId.get(depId)?.status === 'completed');
    });
    ready.sort((a, b) => (a.layerIndex - b.layerIndex) || (a.id - b.id));
    return ready.map((task) => clone(task));
  }

  async markTasksRunning(runId: string, dispatches: TaskDispatchInput[]): Promise<void> {
    if (dispatches.length === 0) {
      return;
    }
    const tasks = this.store.planTasksByRunId.get(runId) ?? [];
    const dispatchByTaskId = new Map(dispatches.map((dispatch) => [dispatch.taskId, dispatch]));
    let updated = false;
    for (let index = 0; index < tasks.length; index += 1) {
      const task = tasks[index];
      const dispatch = task ? dispatchByTaskId.get(task.taskId) : undefined;
      if (!task || !dispatch || task.status !== 'planned') {
        continue;
      }
      tasks[index] = {
        ...task,
        status: 'running',
        childRunId: dispatch.childRunId,
        toolCallId: dispatch.toolCallId,
        updatedAt: nowIso(),
      };
      updated = true;
    }
    if (updated) {
      this.store.planTasksByRunId.set(runId, tasks);
    }
  }
}


