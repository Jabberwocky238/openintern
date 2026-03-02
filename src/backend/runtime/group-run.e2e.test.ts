import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Event } from '../../types/events.js';
import type { LLMResponse, Message } from '../../types/agent.js';
import { createLLMClient } from '../agent/llm-client.js';
import type { RunDependency, RunRecord } from './models.js';
import { SingleAgentRunner, type RunnerContext } from './agent-runner.js';
import { RuntimeToolRouter } from './tool-router.js';
import { SwarmCoordinator } from './swarm-coordinator.js';

vi.mock('../agent/llm-client.js', () => ({
  createLLMClient: vi.fn(),
}));

const mockedCreateLLMClient = vi.mocked(createLLMClient);

interface RunnerOutput {
  events: Event[];
  result: Awaited<ReturnType<SingleAgentRunner['run']> extends AsyncGenerator<Event, infer R, void> ? R : never>;
}

async function collect(generator: AsyncGenerator<Event, RunnerOutput['result'], void>): Promise<RunnerOutput> {
  const events: Event[] = [];
  while (true) {
    const next = await generator.next();
    if (next.done) {
      return { events, result: next.value };
    }
    events.push(next.value);
  }
}

function usage(): LLMResponse['usage'] {
  return {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
  };
}

function toRunRecord(
  id: string,
  agentId: string,
  status: RunRecord['status'],
  parentRunId: string | null
): RunRecord {
  return {
    id,
    orgId: 'org_group',
    userId: 'user_group',
    projectId: null,
    groupId: null,
    sessionKey: 's_group',
    input: 'group request',
    status,
    agentId,
    llmConfig: null,
    result: null,
    error: null,
    parentRunId,
    delegatedPermissions: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    endedAt: null,
    cancelledAt: null,
    suspendedAt: null,
    suspendReason: null,
  };
}

describe('Group run e2e flow (dispatcher -> workers -> summary)', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'group-run-e2e-'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  });

  it('suspends dispatcher, fan-ins 2 child completions, and resumes to final markdown', async () => {
    const runStore = new Map<string, RunRecord>();
    const parentRunId = 'run_parent_group';
    runStore.set(parentRunId, toRunRecord(parentRunId, 'dispatcher', 'running', null));

    const deps: RunDependency[] = [];
    let depId = 0;
    const childQueue: string[] = [];
    const wakeQueue: string[] = [];

    const runRepository = {
      createRun: vi.fn(async (input: {
        id: string;
        agentId: string;
        parentRunId?: string;
      }) => {
        const rec = toRunRecord(
          input.id,
          input.agentId,
          'pending',
          input.parentRunId ?? null
        );
        runStore.set(input.id, rec);
        return rec;
      }),
      createDependency: vi.fn(async (
        parent: string,
        child: string,
        toolCallId: string,
        roleId: string | null,
        goal: string
      ) => {
        const record: RunDependency = {
          id: ++depId,
          parentRunId: parent,
          childRunId: child,
          toolCallId,
          roleId,
          goal,
          status: 'pending',
          result: null,
          error: null,
          createdAt: new Date().toISOString(),
          completedAt: null,
        };
        deps.push(record);
        return record;
      }),
      completeDependencyAtomic: vi.fn(async (
        childRunId: string,
        status: 'completed' | 'failed',
        result?: string,
        error?: string
      ) => {
        const current = deps.find((d) => d.childRunId === childRunId);
        if (!current) return null;
        current.status = status;
        current.result = result ?? null;
        current.error = error ?? null;
        current.completedAt = new Date().toISOString();
        const pendingCount = deps.filter(
          (d) => d.parentRunId === current.parentRunId && d.status === 'pending'
        ).length;
        return { dep: current, pendingCount };
      }),
      listDependenciesByParent: vi.fn(async (parentRunIdArg: string) =>
        deps.filter((d) => d.parentRunId === parentRunIdArg)
      ),
      setRunResumedFromSuspension: vi.fn(async (runId: string) => {
        const current = runStore.get(runId);
        if (current) {
          current.status = 'pending';
        }
      }),
      getRunById: vi.fn(async (runId: string) => runStore.get(runId) ?? null),
    };
    const checkpointState = new Map<string, {
      stepId: string;
      stepNumber: number;
      messages: Message[];
      workingState: Record<string, unknown>;
    }>();
    const checkpointService = {
      save: vi.fn(async (
        runId: string,
        _agentId: string,
        stepId: string,
        messages: Message[],
        _lastSavedCount: number,
        workingState: Record<string, unknown>
      ) => {
        checkpointState.set(runId, {
          stepId,
          stepNumber: Number.parseInt(stepId.replace('step_', ''), 10),
          messages: [...messages],
          workingState,
        });
      }),
      loadLatest: vi.fn(async (runId: string, _agentId?: string) => {
        const cp = checkpointState.get(runId);
        if (!cp) return null;
        return {
          stepId: cp.stepId,
          stepNumber: cp.stepNumber,
          messages: [...cp.messages],
          workingState: cp.workingState,
        };
      }),
      appendToolResults: vi.fn(async (
        runId: string,
        _agentId: string,
        messages: Array<{ role: 'tool'; content: unknown; toolCallId: string }>
      ) => {
        const cp = checkpointState.get(runId);
        if (!cp) throw new Error(`No checkpoint for ${runId}`);
        cp.messages.push(...messages.map((m) => ({
          role: 'tool' as const,
          content: String(m.content),
          toolCallId: m.toolCallId,
        })));
      }),
    };
    const roleRepository = {
      getById: vi.fn(async (id: string) => ({
        id,
        name: id,
      })),
    };
    const memoryService = {
      memory_search_pa: vi.fn(async () => []),
      memory_search_tiered: vi.fn(async () => []),
      memory_search: vi.fn(async () => []),
      memory_get: vi.fn(async () => null),
      memory_write: vi.fn(async () => ({ id: 'mem_1' })),
    };
    const eventService = {
      list: vi.fn(async () => ({ events: [], next_cursor: null })),
    };
    const runQueue = {
      enqueue: vi.fn((runId: string) => {
        childQueue.push(runId);
      }),
    };

    const toolRouter = new RuntimeToolRouter({
      scope: { orgId: 'org_group', userId: 'user_group', projectId: null },
      memoryService: memoryService as never,
      eventService: eventService as never,
      workDir,
      runRepository: runRepository as never,
      roleRepository: roleRepository as never,
      runQueue,
      currentRunId: parentRunId,
      currentSessionKey: 's_group',
    });
    toolRouter.setRunContext(parentRunId, 's_group');

    mockedCreateLLMClient.mockReturnValue({
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          content: 'dispatching workers',
          usage: usage(),
          toolCalls: [
            {
              id: 'tc_dispatch_workers',
              name: 'dispatch_subtasks',
              parameters: {
                subtasks: [
                  { role_id: 'role_worker_a', goal: 'collect data' },
                  { role_id: 'role_worker_b', goal: 'analyze data' },
                ],
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          content: '## Summary\n- worker A done\n- worker B done',
          usage: usage(),
        }),
    });

    const runner = new SingleAgentRunner({
      maxSteps: 4,
      modelConfig: { provider: 'mock', model: 'mock-model' },
      checkpointService: checkpointService as never,
      memoryService: memoryService as never,
      toolRouter,
    });

    const baseContext: RunnerContext = {
      runId: parentRunId,
      sessionKey: 's_group',
      scope: {
        orgId: 'org_group',
        userId: 'user_group',
        projectId: null,
      },
      agentId: 'dispatcher',
      onSuspend: async (reason: string) => {
        const current = runStore.get(parentRunId);
        if (current) {
          current.status = 'suspended';
          current.suspendReason = reason;
          current.suspendedAt = new Date().toISOString();
        }
      },
    };

    const firstPass = await collect(runner.run('老板分配任务', baseContext));
    expect(firstPass.result.status).toBe('suspended');
    expect(firstPass.events.some((e) => e.type === 'run.suspended')).toBe(true);
    expect(deps).toHaveLength(2);
    expect(childQueue).toHaveLength(2);
    expect(runStore.get(parentRunId)?.status).toBe('suspended');

    const coordinator = new SwarmCoordinator({
      runRepository: runRepository as never,
      checkpointService: checkpointService as never,
      enqueueRun: (runId: string) => {
        wakeQueue.push(runId);
      },
    });
    await Promise.all([
      coordinator.onChildTerminal(deps[0]!.childRunId, 'completed', 'worker-a-result'),
      coordinator.onChildTerminal(deps[1]!.childRunId, 'completed', 'worker-b-result'),
    ]);

    expect(wakeQueue).toEqual([parentRunId]);
    const storedAfterFanIn = checkpointState.get(parentRunId);
    expect(storedAfterFanIn).toBeDefined();
    expect(storedAfterFanIn?.messages.length).toBe(3);
    const injectedMessage = storedAfterFanIn?.messages[2];
    expect(injectedMessage?.role).toBe('tool');
    expect(injectedMessage?.toolCallId).toMatch(/tc_dispatch_workers$/);
    const injectedPayload = JSON.parse((injectedMessage?.content as string) ?? '{}') as {
      child_results?: Array<{ child_run_id: string }>;
    };
    expect(injectedPayload.child_results).toHaveLength(2);

    const resume = await checkpointService.loadLatest(parentRunId, 'dispatcher');
    expect(resume).not.toBeNull();
    const secondPass = await collect(runner.run('老板分配任务', {
      ...baseContext,
      resumeFrom: {
        stepNumber: resume!.stepNumber,
        messages: resume!.messages,
        workingState: resume!.workingState,
      },
    }));

    expect(secondPass.events[0]?.type).toBe('run.resumed');
    expect(secondPass.result.status).toBe('completed');
    expect(secondPass.result.output).toContain('## Summary');
  });
});

