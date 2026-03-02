import { describe, expect, it, vi } from 'vitest';
import type { RunDependency, RunRecord } from './models.js';
import { SwarmCoordinator } from './swarm-coordinator.js';

function dep(
  parentRunId: string,
  childRunId: string,
  toolCallId: string,
  status: RunDependency['status'],
  result: string | null = null,
  error: string | null = null
): RunDependency {
  return {
    id: Math.floor(Math.random() * 10000),
    parentRunId,
    childRunId,
    toolCallId,
    roleId: 'role_worker',
    goal: `goal-${childRunId}`,
    status,
    result,
    error,
    createdAt: new Date().toISOString(),
    completedAt: status === 'pending' ? null : new Date().toISOString(),
  };
}

function parentRun(id: string, agentId: string): RunRecord {
  return {
    id,
    orgId: 'org_test',
    userId: 'user_test',
    projectId: null,
    groupId: null,
    sessionKey: 's_test',
    input: 'parent work',
    status: 'suspended',
    agentId,
    llmConfig: null,
    result: null,
    error: null,
    parentRunId: null,
    delegatedPermissions: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    endedAt: null,
    cancelledAt: null,
    suspendedAt: new Date().toISOString(),
    suspendReason: 'waiting children',
  };
}

describe('SwarmCoordinator', () => {
  it('does not wake parent when pending dependency count is still > 0', async () => {
    const runRepository = {
      completeDependencyAtomic: vi.fn(async () => ({
        dep: dep('run_parent', 'run_child_1', 'tc_dispatch', 'completed', 'ok'),
        pendingCount: 1,
      })),
      listDependenciesByParent: vi.fn(async () => []),
      setRunResumedFromSuspension: vi.fn(async () => undefined),
      getRunById: vi.fn(async () => parentRun('run_parent', 'dispatcher')),
    };
    const checkpointService = {
      appendToolResults: vi.fn(async () => undefined),
    };
    const enqueueRun = vi.fn();

    const coordinator = new SwarmCoordinator({
      runRepository: runRepository as never,
      checkpointService: checkpointService as never,
      enqueueRun,
    });

    await coordinator.onChildTerminal('run_child_1', 'completed', 'ok');

    expect(runRepository.completeDependencyAtomic).toHaveBeenCalledTimes(1);
    expect(runRepository.listDependenciesByParent).not.toHaveBeenCalled();
    expect(checkpointService.appendToolResults).not.toHaveBeenCalled();
    expect(runRepository.setRunResumedFromSuspension).not.toHaveBeenCalled();
    expect(enqueueRun).not.toHaveBeenCalled();
  });

  it('wakes parent only once under concurrent child terminal events and injects one aggregated tool message', async () => {
    const parentRunId = 'run_parent_concurrent';
    const childIds = ['run_child_a', 'run_child_b', 'run_child_c'] as const;
    const outcomes = new Map<string, { dep: RunDependency; pendingCount: number }>([
      [childIds[0], { dep: dep(parentRunId, childIds[0], 'tc_dispatch', 'completed', 'a-ok'), pendingCount: 2 }],
      [childIds[1], { dep: dep(parentRunId, childIds[1], 'tc_dispatch', 'completed', 'b-ok'), pendingCount: 1 }],
      [childIds[2], { dep: dep(parentRunId, childIds[2], 'tc_dispatch', 'completed', 'c-ok'), pendingCount: 0 }],
    ]);
    const allDeps = [
      dep(parentRunId, childIds[0], 'tc_dispatch', 'completed', 'a-ok'),
      dep(parentRunId, childIds[1], 'tc_dispatch', 'completed', 'b-ok'),
      dep(parentRunId, childIds[2], 'tc_dispatch', 'completed', 'c-ok'),
    ];

    const runRepository = {
      completeDependencyAtomic: vi.fn(async (childRunId: string) => {
        await Promise.resolve();
        return outcomes.get(childRunId) ?? null;
      }),
      listDependenciesByParent: vi.fn(async () => allDeps),
      setRunResumedFromSuspension: vi.fn(async () => undefined),
      getRunById: vi.fn(async () => parentRun(parentRunId, 'dispatcher')),
    };
    const checkpointService = {
      appendToolResults: vi.fn(async () => undefined),
    };
    const enqueueRun = vi.fn();

    const coordinator = new SwarmCoordinator({
      runRepository: runRepository as never,
      checkpointService: checkpointService as never,
      enqueueRun,
    });

    await Promise.all(
      childIds.map((childId) => coordinator.onChildTerminal(childId, 'completed', `${childId}-done`))
    );

    expect(runRepository.completeDependencyAtomic).toHaveBeenCalledTimes(3);
    expect(runRepository.setRunResumedFromSuspension).toHaveBeenCalledTimes(1);
    expect(enqueueRun).toHaveBeenCalledTimes(1);
    expect(enqueueRun).toHaveBeenCalledWith(parentRunId);
    expect(checkpointService.appendToolResults).toHaveBeenCalledTimes(1);

    const appendArgs = checkpointService.appendToolResults.mock.calls[0] as unknown[];
    const messages = appendArgs[2] as Array<{ toolCallId: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.toolCallId).toBe('tc_dispatch');
    const parsed = JSON.parse(messages[0]?.content ?? '{}') as {
      child_results?: Array<{ child_run_id: string }>;
    };
    expect(parsed.child_results?.map((r) => r.child_run_id).sort()).toEqual([...childIds].sort());
  });

  it('injects tool message with original tool_call_id and all child results in content JSON', async () => {
    const parentRunId = 'run_parent_inject';
    const deps = [
      dep(parentRunId, 'run_child_1', 'tc_original_dispatch', 'completed', 'result-1'),
      dep(parentRunId, 'run_child_2', 'tc_original_dispatch', 'failed', null, 'boom'),
    ];
    const runRepository = {
      completeDependencyAtomic: vi.fn(async () => ({
        dep: deps[1],
        pendingCount: 0,
      })),
      listDependenciesByParent: vi.fn(async () => deps),
      setRunResumedFromSuspension: vi.fn(async () => undefined),
      getRunById: vi.fn(async () => parentRun(parentRunId, 'dispatcher')),
    };
    const checkpointService = {
      appendToolResults: vi.fn(async () => undefined),
    };
    const enqueueRun = vi.fn();

    const coordinator = new SwarmCoordinator({
      runRepository: runRepository as never,
      checkpointService: checkpointService as never,
      enqueueRun,
    });

    await coordinator.onChildTerminal('run_child_2', 'failed', undefined, 'boom');

    const appendArgs = checkpointService.appendToolResults.mock.calls[0] as unknown[];
    const messages = appendArgs[2] as Array<{ role: string; toolCallId: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('tool');
    expect(messages[0]?.toolCallId).toBe('tc_original_dispatch');
    const parsed = JSON.parse(messages[0]?.content ?? '{}') as {
      child_results?: Array<{ child_run_id: string; status: string }>;
    };
    expect(parsed.child_results).toBeDefined();
    expect(parsed.child_results).toHaveLength(2);
    expect(parsed.child_results?.map((r) => r.child_run_id)).toEqual(['run_child_1', 'run_child_2']);
  });
});

