import type { NormalizedPlannerTask, PlannerTask } from './plan-schema.js';
import { PlannerOutputSchema } from './plan-schema.js';

export class PlanValidationError extends Error {
  code: string;

  constructor(message: string, code: string = 'PLAN_INVALID') {
    super(message);
    this.name = 'PlanValidationError';
    this.code = code;
  }
}

function assertUniqueIds(tasks: PlannerTask[]): void {
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) {
      throw new PlanValidationError(`Duplicate task id: ${task.id}`);
    }
    seen.add(task.id);
  }
}

function assertDependenciesExist(tasks: PlannerTask[]): void {
  const ids = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    for (const dependency of task.depends_on) {
      if (!ids.has(dependency)) {
        throw new PlanValidationError(
          `Task ${task.id} depends on missing task ${dependency}`
        );
      }
      if (dependency === task.id) {
        throw new PlanValidationError(`Task ${task.id} cannot depend on itself`);
      }
    }
  }
}

function assertRolesAllowed(tasks: PlannerTask[], allowedRoleIds: Set<string>): void {
  if (allowedRoleIds.size === 0) return;
  for (const task of tasks) {
    if (!allowedRoleIds.has(task.role_id)) {
      throw new PlanValidationError(`Task ${task.id} uses unknown role_id ${task.role_id}`);
    }
  }
}

function computeLayerIndex(tasks: PlannerTask[]): Map<string, number> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  const layerById = new Map<string, number>();
  for (const task of tasks) {
    indegree.set(task.id, task.depends_on.length);
    layerById.set(task.id, 0);
  }
  for (const task of tasks) {
    for (const dependency of task.depends_on) {
      const children = adjacency.get(dependency) ?? [];
      children.push(task.id);
      adjacency.set(dependency, children);
    }
  }

  const queue = tasks.filter((task) => task.depends_on.length === 0).map((task) => task.id);
  let visited = 0;
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    visited += 1;
    const currentLayer = layerById.get(currentId) ?? 0;
    for (const childId of adjacency.get(currentId) ?? []) {
      const nextIndegree = (indegree.get(childId) ?? 0) - 1;
      indegree.set(childId, nextIndegree);
      const existingLayer = layerById.get(childId) ?? 0;
      layerById.set(childId, Math.max(existingLayer, currentLayer + 1));
      if (nextIndegree === 0) {
        queue.push(childId);
      }
    }
  }

  if (visited !== tasks.length) {
    const cyclicIds = [...byId.keys()].filter((id) => (indegree.get(id) ?? 0) > 0);
    throw new PlanValidationError(
      `Dependency cycle detected involving tasks: ${cyclicIds.join(', ')}`
    );
  }
  return layerById;
}

export function validatePlannerOutput(
  rawOutput: unknown,
  allowedRoleIds: string[]
): { rawPlan: Record<string, unknown>; tasks: NormalizedPlannerTask[] } {
  const parsed = PlannerOutputSchema.safeParse(rawOutput);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PlanValidationError(issue?.message ?? 'Planner output is invalid JSON schema');
  }

  const tasks = parsed.data.tasks;
  assertUniqueIds(tasks);
  assertDependenciesExist(tasks);
  assertRolesAllowed(tasks, new Set(allowedRoleIds));
  const layerById = computeLayerIndex(tasks);

  const normalized = tasks.map((task) => ({
    id: task.id,
    task: task.task,
    roleId: task.role_id,
    dependsOn: [...task.depends_on],
    ...(task.context ? { context: task.context } : {}),
    ...(task.acceptance ? { acceptance: task.acceptance } : {}),
    layerIndex: layerById.get(task.id) ?? 0,
  }));
  return {
    rawPlan: parsed.data as unknown as Record<string, unknown>,
    tasks: normalized,
  };
}

