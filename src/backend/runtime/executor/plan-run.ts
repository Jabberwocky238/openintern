import type { QueuedRun } from '../../../types/api.js';
import type { LLMConfig } from '../../../types/agent.js';
import type { Event, EventType } from '../../../types/events.js';
import { generateRunId, generateSpanId, generateStepId } from '../../../utils/ids.js';
import type { RuntimeExecutorConfig } from '../executor.js';
import type { PlanRecord, PlanTaskRecord } from '../models.js';
import { generatePlanOutput } from '../planner/planner-client.js';
import { PlanValidationError, validatePlannerOutput } from '../planner/plan-validator.js';
import type { IPlanRepository } from '@openintern/repository';

type Scope = { orgId: string; userId: string; projectId: string | null };
type RunTerminalStatus = 'completed' | 'failed' | 'cancelled' | 'suspended';
type EmitEventFn = (
  type: EventType,
  payload: Event['payload'],
  messageType?: Event['message_type']
) => Promise<void>;

interface PlannerRoleInput {
  id: string;
  name: string;
  description: string;
}

interface PlanRuntimeDeps {
  planRepository: IPlanRepository;
  runQueue: NonNullable<RuntimeExecutorConfig['runQueue']>;
}

interface DispatchResult {
  dispatchedCount: number;
  layerIndex: number;
}

interface TaskState {
  completedCount: number;
  failedTask: PlanTaskRecord | null;
  hasRunningTask: boolean;
}

function requirePlanRuntimeDeps(config: RuntimeExecutorConfig): PlanRuntimeDeps {
  if (!config.planRepository) {
    throw new Error('Plan repository is required for run_mode=plan_execute');
  }
  if (!config.runQueue) {
    throw new Error('Run queue is required for run_mode=plan_execute');
  }
  return { planRepository: config.planRepository, runQueue: config.runQueue };
}

function buildChildInput(task: PlanTaskRecord): string {
  const lines = [`Goal: ${task.task}`];
  if (task.context) {
    lines.push('', `Context: ${task.context}`);
  }
  if (task.acceptance) {
    lines.push('', `Acceptance Criteria: ${task.acceptance}`);
  }
  return lines.join('\n');
}

function buildFinalOutput(tasks: PlanTaskRecord[]): string {
  const ordered = [...tasks].sort((a, b) =>
    a.layerIndex === b.layerIndex ? a.id - b.id : a.layerIndex - b.layerIndex
  );
  const lines = ['Plan-and-Execute completed.', ''];
  for (const task of ordered) {
    lines.push(`- [${task.taskId}] (${task.roleId}) ${task.task}`);
    lines.push(`  ${task.output ?? '(no output)'}`);
  }
  return lines.join('\n');
}

function createEventEmitter(config: RuntimeExecutorConfig, run: QueuedRun): EmitEventFn {
  const rootSpan = generateSpanId();
  let stepNumber = 0;
  return async (type, payload, messageType) => {
    const event: Event = {
      v: 1,
      ts: new Date().toISOString(),
      session_key: run.session_key,
      run_id: run.run_id,
      agent_id: run.agent_id,
      step_id: generateStepId(stepNumber),
      span_id: rootSpan,
      parent_span_id: null,
      redaction: { contains_secrets: false },
      type,
      payload,
      ...(run.group_id ? { group_id: run.group_id } : {}),
      ...(messageType ? { message_type: messageType } : {}),
    } as Event;
    await config.eventService.write(event);
    config.sseManager.broadcastToRun(run.run_id, event);
    stepNumber += 1;
  };
}

async function resolvePlannerRoles(
  config: RuntimeExecutorConfig,
  run: QueuedRun
): Promise<PlannerRoleInput[]> {
  if (run.group_id) {
    const members = await config.groupRepository.listMembers(run.group_id);
    const groupRoles: PlannerRoleInput[] = [];
    for (const member of members) {
      const role = await config.roleRepository.getById(member.role_id);
      if (!role) continue;
      groupRoles.push({ id: role.id, name: role.name, description: role.description });
    }
    if (groupRoles.length > 0) return groupRoles;
  }

  const allRoles = await config.roleRepository.list();
  if (allRoles.length > 0) {
    return allRoles.map((role) => ({
      id: role.id,
      name: role.name,
      description: role.description,
    }));
  }

  return [{
    id: run.agent_id,
    name: run.agent_id,
    description: 'Default worker role for plan execution',
  }];
}

async function failRun(
  config: RuntimeExecutorConfig,
  run: QueuedRun,
  planRepository: IPlanRepository,
  emit: EmitEventFn,
  code: string,
  message: string
): Promise<RunTerminalStatus> {
  await planRepository.markPlanStatus(run.run_id, 'failed', message);
  await config.runRepository.setRunFailed(run.run_id, { code, message });
  await emit('message.status', { state: 'error', blockers: [message] }, 'STATUS');
  await emit('run.failed', { error: { code, message } });
  return 'failed';
}

async function createPlan(
  config: RuntimeExecutorConfig,
  run: QueuedRun,
  modelConfig: LLMConfig,
  signal: AbortSignal
): Promise<{ plan: PlanRecord } | { code: string; message: string }> {
  const roles = await resolvePlannerRoles(config, run);
  const plannerConfig = config.plannerModelConfig ?? modelConfig;
  try {
    const plannerOutput = await generatePlanOutput({
      modelConfig: plannerConfig,
      userInput: run.input,
      roles,
      signal,
    });
    const validated = validatePlannerOutput(plannerOutput, roles.map((role) => role.id));
    const created = await config.planRepository!.createPlan({
      runId: run.run_id,
      plannerModel: plannerConfig.model,
      rawPlan: validated.rawPlan,
      tasks: validated.tasks.map((task) => ({
        taskId: task.id,
        task: task.task,
        roleId: task.roleId,
        dependsOn: task.dependsOn,
        layerIndex: task.layerIndex,
        ...(task.context ? { context: task.context } : {}),
        ...(task.acceptance ? { acceptance: task.acceptance } : {}),
      })),
    });
    return { plan: created.plan };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof PlanValidationError ? error.code : 'PLAN_GENERATION_ERROR';
    return { code, message };
  }
}

async function ensurePlan(
  config: RuntimeExecutorConfig,
  run: QueuedRun,
  modelConfig: LLMConfig,
  signal: AbortSignal,
  emit: EmitEventFn
): Promise<{ plan: PlanRecord } | { code: string; message: string }> {
  const existingPlan = await config.planRepository!.getPlanByRunId(run.run_id);
  if (existingPlan) {
    await emit('run.resumed', { checkpoint_step_id: 'step_0000', orphaned_tool_calls: 0 });
    return { plan: existingPlan };
  }
  await emit('run.started', { input: run.input, config: { run_mode: 'plan_execute' } });
  return createPlan(config, run, modelConfig, signal);
}

async function completeRun(
  config: RuntimeExecutorConfig,
  run: QueuedRun,
  planRepository: IPlanRepository,
  tasks: PlanTaskRecord[],
  emit: EmitEventFn
): Promise<RunTerminalStatus> {
  const output = buildFinalOutput(tasks);
  await planRepository.markPlanStatus(run.run_id, 'completed');
  await emit(
    'message.decision',
    {
      decision: output,
      rationale: `Completed ${tasks.length} planned task(s)`,
      next_actions: [],
      evidence_refs: [],
    },
    'DECISION'
  );
  await config.runRepository.setRunCompleted(run.run_id, output);
  await emit('run.completed', { output, duration_ms: 0 });
  return 'completed';
}

async function suspendRun(
  config: RuntimeExecutorConfig,
  run: QueuedRun,
  emit: EmitEventFn,
  reason: string,
  toolCallId: string
): Promise<RunTerminalStatus> {
  await config.runRepository.setRunSuspended(run.run_id, reason);
  await emit('run.suspended', {
    toolCallId,
    toolName: 'plan_execute_dispatch',
    reason,
  });
  return 'suspended';
}

function summarizeTaskState(tasks: PlanTaskRecord[]): TaskState {
  let completedCount = 0;
  let failedTask: PlanTaskRecord | null = null;
  let hasRunningTask = false;
  for (const task of tasks) {
    if (task.status === 'completed') completedCount += 1;
    if (task.status === 'failed' && !failedTask) failedTask = task;
    if (task.status === 'running') hasRunningTask = true;
  }
  return { completedCount, failedTask, hasRunningTask };
}

async function dispatchSingleTask(args: {
  config: RuntimeExecutorConfig;
  deps: PlanRuntimeDeps;
  run: QueuedRun;
  scope: Scope;
  plan: PlanRecord;
  task: PlanTaskRecord;
  emit: EmitEventFn;
}): Promise<{ taskId: string; childRunId: string; toolCallId: string }> {
  const childRunId = generateRunId();
  const toolCallId = `plan_task_${args.task.taskId}`;
  const childInput = buildChildInput(args.task);
  await args.config.runRepository.createRun({
    id: childRunId,
    scope: args.scope,
    sessionKey: args.run.session_key,
    input: childInput,
    agentId: args.task.roleId,
    runMode: 'single',
    llmConfig: args.run.llm_config ?? null,
    parentRunId: args.run.run_id,
  });
  await args.config.runRepository.createDependency(
    args.run.run_id,
    childRunId,
    toolCallId,
    args.task.roleId,
    args.task.task
  );
  args.deps.runQueue.enqueue({
    run_id: childRunId,
    org_id: args.scope.orgId,
    user_id: args.scope.userId,
    ...(args.scope.projectId ? { project_id: args.scope.projectId } : {}),
    session_key: args.run.session_key,
    input: childInput,
    agent_id: args.task.roleId,
    run_mode: 'single',
    created_at: new Date().toISOString(),
    status: 'pending',
    ...(args.run.llm_config ? { llm_config: args.run.llm_config } : {}),
    parent_run_id: args.run.run_id,
  });
  await args.emit(
    'message.task',
    {
      goal: args.task.task,
      inputs: {
        plan_id: args.plan.id,
        task_id: args.task.taskId,
        depends_on: args.task.dependsOn,
        layer: args.task.layerIndex,
        child_run_id: childRunId,
      },
      ...(args.task.acceptance ? { expected_output: args.task.acceptance } : {}),
      constraints: args.task.context ? [args.task.context] : [],
      priority: 'high',
    },
    'TASK'
  );
  return { taskId: args.task.taskId, childRunId, toolCallId };
}

async function dispatchLayerTasks(
  config: RuntimeExecutorConfig,
  deps: PlanRuntimeDeps,
  run: QueuedRun,
  scope: Scope,
  plan: PlanRecord,
  readyTasks: PlanTaskRecord[],
  emit: EmitEventFn
): Promise<DispatchResult> {
  const layerIndex = Math.min(...readyTasks.map((task) => task.layerIndex));
  const tasksToDispatch = readyTasks.filter((task) => task.layerIndex === layerIndex);
  const dispatches: Array<{ taskId: string; childRunId: string; toolCallId: string }> = [];

  for (const task of tasksToDispatch) {
    const dispatched = await dispatchSingleTask({
      config,
      deps,
      run,
      scope,
      plan,
      task,
      emit,
    });
    dispatches.push(dispatched);
  }

  await deps.planRepository.markTasksRunning(run.run_id, dispatches);
  await deps.planRepository.markPlanStatus(run.run_id, 'running');
  return { dispatchedCount: tasksToDispatch.length, layerIndex };
}

export async function executePlanRun(
  config: RuntimeExecutorConfig,
  run: QueuedRun,
  scope: Scope,
  modelConfig: LLMConfig,
  signal: AbortSignal
): Promise<RunTerminalStatus> {
  const deps = requirePlanRuntimeDeps(config);
  const emit = createEventEmitter(config, run);

  if (signal.aborted) {
    await config.runRepository.setRunCancelled(run.run_id);
    return 'cancelled';
  }

  const planResult = await ensurePlan(config, run, modelConfig, signal, emit);
  if ('code' in planResult) {
    return failRun(config, run, deps.planRepository, emit, planResult.code, planResult.message);
  }

  await deps.planRepository.syncTaskStatusFromDependencies(run.run_id);
  const tasks = await deps.planRepository.listTasksByRunId(run.run_id);
  if (tasks.length === 0) {
    return failRun(config, run, deps.planRepository, emit, 'PLAN_INVALID', 'Task plan has no executable items');
  }

  const taskState = summarizeTaskState(tasks);
  if (taskState.failedTask) {
    const reason = taskState.failedTask.error ?? `Task ${taskState.failedTask.taskId} failed`;
    return failRun(config, run, deps.IPlanRepository, emit, 'PLAN_TASK_FAILED', reason);
  }

  if (taskState.completedCount === tasks.length) {
    return completeRun(config, run, deps.planRepository, tasks, emit);
  }

  const readyTasks = await deps.planRepository.listReadyTasksByRunId(run.run_id);
  if (readyTasks.length === 0) {
    if (taskState.hasRunningTask) {
      return suspendRun(config, run, emit, 'Waiting for dispatched plan tasks to finish', 'plan_execute_wait');
    }
    return failRun(
      config,
      run,
      deps.IPlanRepository,
      emit,
      'PLAN_STALLED',
      'No ready tasks and no running tasks remain'
    );
  }

  const dispatch = await dispatchLayerTasks(config, deps, run, scope, planResult.plan, readyTasks, emit);
  await emit(
    'message.status',
    { state: 'working', progress: taskState.completedCount / tasks.length, blockers: [] },
    'STATUS'
  );
  const reason = `Dispatched ${dispatch.dispatchedCount} task(s) in layer ${dispatch.layerIndex}`;
  return suspendRun(config, run, emit, reason, `plan_layer_${dispatch.layerIndex}`);
}





