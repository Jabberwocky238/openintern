import { describe, expect, it, vi } from 'vitest';
import type { QueuedRun } from '@openintern/types/api.js';
import { executePlanRun } from './plan-run.js';

vi.mock('../planner/planner-client.js', () => ({
  generatePlanOutput: vi.fn(async () => ({
    tasks: [
      { id: 't1', task: 'prepare data', role_id: 'role_a', depends_on: [] },
      { id: 't2', task: 'train model', role_id: 'role_b', depends_on: ['t1'] },
    ],
  })),
}));

describe('executePlanRun', () => {
  it('creates planner DAG and dispatches the first layer', async () => {
    const tasks = [
      {
        id: 1,
        planId: 1,
        runId: 'run_plan_1',
        taskId: 't1',
        task: 'prepare data',
        roleId: 'role_a',
        dependsOn: [],
        layerIndex: 0,
        status: 'planned' as const,
        context: null,
        acceptance: null,
        childRunId: null,
        toolCallId: null,
        output: null,
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: 2,
        planId: 1,
        runId: 'run_plan_1',
        taskId: 't2',
        task: 'train model',
        roleId: 'role_b',
        dependsOn: ['t1'],
        layerIndex: 1,
        status: 'planned' as const,
        context: null,
        acceptance: null,
        childRunId: null,
        toolCallId: null,
        output: null,
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    const planRepository = {
      getPlanByRunId: vi.fn(async () => null),
      createPlan: vi.fn(async () => ({
        plan: {
          id: 1,
          runId: 'run_plan_1',
          plannerModel: 'mock-planner',
          status: 'planned' as const,
          rawPlan: { tasks: [] },
          failureReason: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        tasks,
      })),
      syncTaskStatusFromDependencies: vi.fn(async () => []),
      listTasksByRunId: vi.fn(async () => tasks),
      listReadyTasksByRunId: vi.fn(async () => tasks.filter((task) => task.layerIndex === 0)),
      markTasksRunning: vi.fn(async () => undefined),
      markPlanStatus: vi.fn(async () => undefined),
    };

    const config = {
      planRepository,
      plannerModelConfig: { provider: 'mock', model: 'mock-planner' },
      runQueue: { enqueue: vi.fn(), notifyRunWaiting: vi.fn(), notifyRunResumed: vi.fn() },
      runRepository: {
        createRun: vi.fn(async () => undefined),
        createDependency: vi.fn(async () => undefined),
        setRunSuspended: vi.fn(async () => undefined),
        setRunFailed: vi.fn(async () => undefined),
        setRunCompleted: vi.fn(async () => undefined),
        setRunCancelled: vi.fn(async () => undefined),
      },
      roleRepository: {
        list: vi.fn(async () => [
          { id: 'role_a', name: 'Role A', description: 'A' },
          { id: 'role_b', name: 'Role B', description: 'B' },
        ]),
        getById: vi.fn(async () => null),
      },
      groupRepository: {
        listMembers: vi.fn(async () => []),
      },
      eventService: {
        write: vi.fn(async () => undefined),
      },
      sseManager: {
        broadcastToRun: vi.fn(),
      },
    };

    const run: QueuedRun = {
      run_id: 'run_plan_1',
      org_id: 'org_test',
      user_id: 'user_test',
      session_key: 's_test',
      input: 'build an openset KD pipeline',
      agent_id: 'main',
      run_mode: 'plan_execute',
      created_at: new Date().toISOString(),
      status: 'pending',
    };

    const status = await executePlanRun(
      config as never,
      run,
      { orgId: 'org_test', userId: 'user_test', projectId: null },
      { provider: 'mock', model: 'mock-worker' },
      new AbortController().signal
    );

    expect(status).toBe('suspended');
    expect(config.runRepository.createRun).toHaveBeenCalledTimes(1);
    expect(config.runRepository.createDependency).toHaveBeenCalledTimes(1);
    expect(planRepository.markTasksRunning).toHaveBeenCalledTimes(1);
    expect(config.runQueue.enqueue).toHaveBeenCalledTimes(1);
  });
});


