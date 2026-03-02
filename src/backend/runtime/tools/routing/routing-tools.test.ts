import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventService } from '../../event-service.js';
import type { MemoryService } from '../../memory-service.js';
import { RuntimeToolRouter } from '../../tool-router.js';

describe('Routing tools', () => {
  let workDir: string;
  const memoryService = {
    memory_search: vi.fn(async () => []),
    memory_get: vi.fn(async () => null),
    memory_write: vi.fn(async () => ({ id: 'mem_1' })),
  };
  const eventService = {
    list: vi.fn(async () => ({ events: [], next_cursor: null })),
  };
  const runRepository = {
    createRun: vi.fn(async (input: { id: string }) => ({
      id: input.id,
      orgId: 'org_test',
      userId: 'user_test',
      projectId: null,
      groupId: null,
      sessionKey: 's_test',
      input: 'child',
      status: 'pending',
      agentId: 'role_1',
      llmConfig: null,
      result: null,
      error: null,
      parentRunId: 'run_parent',
      delegatedPermissions: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      cancelledAt: null,
      suspendedAt: null,
      suspendReason: null,
    })),
    createDependency: vi.fn(async () => ({
      id: 1,
      parentRunId: 'run_parent',
      childRunId: 'run_child',
      toolCallId: 'tc_dispatch',
      roleId: 'role_1',
      goal: 'goal',
      status: 'pending',
      result: null,
      error: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    })),
  };
  const roleRepository = {
    getById: vi.fn(async (_id: string): Promise<{ id: string } | null> => ({ id: 'role_1' })),
  };
  const runQueue = {
    enqueue: vi.fn(),
  };

  beforeEach(async () => {
    workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'routing-tools-test-'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  });

  function createRouter(): RuntimeToolRouter {
    const router = new RuntimeToolRouter({
      scope: {
        orgId: 'org_test',
        userId: 'user_test',
        projectId: null,
      },
      memoryService: memoryService as unknown as MemoryService,
      eventService: eventService as unknown as EventService,
      workDir,
      runRepository: runRepository as never,
      roleRepository: roleRepository as never,
      runQueue,
    });
    router.setRunContext('run_parent', 's_parent');
    return router;
  }

  it('returns success=false for non-existent role_id without suspension', async () => {
    roleRepository.getById.mockResolvedValueOnce(null);
    const router = createRouter();

    const result = await router.callTool('handoff_to', {
      role_id: 'role_missing',
      goal: 'do work',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Role not found: role_missing');
    expect(result.requiresSuspension).not.toBe(true);
    expect(runRepository.createRun).not.toHaveBeenCalled();
    expect(runRepository.createDependency).not.toHaveBeenCalled();
  });

  it('creates child runs and dependencies for dispatch_subtasks and marks suspension required', async () => {
    roleRepository.getById.mockImplementation(async (id: string) => ({ id }));
    const router = createRouter();

    const result = await router.callTool('dispatch_subtasks', {
      __tool_call_id: 'tc_dispatch',
      subtasks: [
        { role_id: 'role_a', goal: 'task a' },
        { role_id: 'role_b', goal: 'task b' },
        { role_id: 'role_c', goal: 'task c' },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.requiresSuspension).toBe(true);
    expect(runRepository.createRun).toHaveBeenCalledTimes(3);
    expect(runRepository.createDependency).toHaveBeenCalledTimes(3);

    const childRunIds = runRepository.createRun.mock.calls.map((call) => {
      const input = (call as unknown[])[0] as { id: string };
      return input.id;
    });
    expect(new Set(childRunIds).size).toBe(3);

    for (const call of runRepository.createDependency.mock.calls) {
      const callArgs = call as unknown[];
      expect(callArgs[0]).toBe('run_parent');
      expect(callArgs[2]).toBe('tc_dispatch');
    }
    expect(runQueue.enqueue).toHaveBeenCalledTimes(3);
    expect(runQueue.enqueue.mock.calls.map((call) => (call as unknown[])[0])).toEqual(childRunIds);
  });
});

