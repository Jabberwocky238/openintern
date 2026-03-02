import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { RunRecord } from '../runtime/models.js';
import { createRunsRouter } from './runs.js';

function makeRun(runId: string, status: RunRecord['status']): RunRecord {
  return {
    id: runId,
    orgId: 'org_test',
    userId: 'user_test',
    projectId: null,
    groupId: null,
    sessionKey: 's_test',
    input: 'resume me',
    status,
    agentId: 'dispatcher',
    llmConfig: null,
    result: null,
    error: null,
    parentRunId: null,
    delegatedPermissions: null,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    cancelledAt: null,
    suspendedAt: status === 'suspended' ? new Date().toISOString() : null,
    suspendReason: status === 'suspended' ? 'approval required' : null,
  };
}

interface TestConfig {
  runRepository: {
    requireRun: (...args: unknown[]) => Promise<RunRecord>;
    setRunResumedFromSuspension: (...args: unknown[]) => Promise<void>;
  };
  runQueue: { enqueue: (...args: unknown[]) => void };
  checkpointService: { appendToolResults: (...args: unknown[]) => Promise<void> };
  approvalManager: {
    approveSuspended: (...args: unknown[]) => Promise<{
      toolName: string;
      effectiveArgs: Record<string, unknown>;
      modifiedArgsApplied: boolean;
    }>;
    getPending: (...args: unknown[]) => unknown;
    approve: (...args: unknown[]) => boolean;
  };
}

function createTestApp(config: TestConfig): Express {
  const app = express();
  app.use(express.json());
  app.use('/api', createRunsRouter({
    runQueue: config.runQueue as never,
    sseManager: {
      getOrCreateClient: vi.fn(),
      removeClient: vi.fn(),
      broadcastToRun: vi.fn(),
      shutdown: vi.fn(),
    } as never,
    runRepository: config.runRepository as never,
    eventService: {
      write: vi.fn(async () => undefined),
      writeBatch: vi.fn(async () => undefined),
      list: vi.fn(async () => ({ events: [], next_cursor: null })),
    } as never,
    checkpointService: config.checkpointService as never,
    approvalManager: config.approvalManager as never,
  }));
  app.use((err: Error & { code?: string; statusCode?: number; details?: unknown }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.statusCode ?? 500).json({
      error: {
        code: err.code ?? 'INTERNAL_ERROR',
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
  });
  return app;
}

describe('Runs API approval routes (unit)', () => {
  it('approves suspended run via approval manager replay and re-enqueues run', async () => {
    const runRepository = {
      requireRun: vi.fn(async () => makeRun('run_suspend_1', 'suspended')),
      setRunResumedFromSuspension: vi.fn(async () => undefined),
    };
    const runQueue = {
      enqueue: vi.fn(),
    };
    const checkpointService = {
      appendToolResults: vi.fn(async () => undefined),
    };
    const approvalManager = {
      approveSuspended: vi.fn(async () => ({
        toolName: 'exec_command',
        effectiveArgs: { command: 'ls -l /' },
        modifiedArgsApplied: true,
      })),
      getPending: vi.fn(),
      approve: vi.fn(),
    };
    const app = createTestApp({ runRepository, runQueue, checkpointService, approvalManager });

    const response = await request(app)
      .post('/api/runs/run_suspend_1/approve')
      .set('x-org-id', 'org_test')
      .set('x-user-id', 'user_test')
      .send({
        tool_call_id: 'tc_approve_1',
        modified_args: { command: 'ls -l /' },
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      run_id: 'run_suspend_1',
      tool_call_id: 'tc_approve_1',
      modified_args_applied: true,
    });
    expect(approvalManager.approveSuspended).toHaveBeenCalledWith({
      runId: 'run_suspend_1',
      sessionKey: 's_test',
      agentId: 'dispatcher',
      toolCallId: 'tc_approve_1',
      modifiedArgs: { command: 'ls -l /' },
      scope: {
        orgId: 'org_test',
        userId: 'user_test',
        projectId: null,
      },
    });
    expect(checkpointService.appendToolResults).not.toHaveBeenCalled();
    expect(runRepository.setRunResumedFromSuspension).toHaveBeenCalledWith('run_suspend_1');
    expect(runQueue.enqueue).toHaveBeenCalledTimes(1);
    expect(runQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      run_id: 'run_suspend_1',
      status: 'pending',
      agent_id: 'dispatcher',
    }));
  });

  it('approves waiting run with full-override args and marks modified_args_applied', async () => {
    const runRepository = {
      requireRun: vi.fn(async () => makeRun('run_wait_1', 'waiting')),
      setRunResumedFromSuspension: vi.fn(async () => undefined),
    };
    const runQueue = {
      enqueue: vi.fn(),
    };
    const checkpointService = {
      appendToolResults: vi.fn(async () => undefined),
    };
    const approvalManager = {
      approveSuspended: vi.fn(),
      getPending: vi.fn(() => ({
        runId: 'run_wait_1',
        args: { path: '/data', recursive: true },
      })),
      approve: vi.fn(() => true),
    };
    const app = createTestApp({ runRepository, runQueue, checkpointService, approvalManager });

    const response = await request(app)
      .post('/api/runs/run_wait_1/approve')
      .set('x-org-id', 'org_test')
      .set('x-user-id', 'user_test')
      .send({
        tool_call_id: 'tc_wait_1',
        modified_args: { path: '/data' },
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      run_id: 'run_wait_1',
      tool_call_id: 'tc_wait_1',
      modified_args_applied: true,
    });
    expect(approvalManager.approve).toHaveBeenCalledWith(
      'tc_wait_1',
      { path: '/data' }
    );
  });

  it('rejects non-object modified_args', async () => {
    const runRepository = {
      requireRun: vi.fn(async () => makeRun('run_wait_2', 'waiting')),
      setRunResumedFromSuspension: vi.fn(async () => undefined),
    };
    const runQueue = {
      enqueue: vi.fn(),
    };
    const checkpointService = {
      appendToolResults: vi.fn(async () => undefined),
    };
    const approvalManager = {
      approveSuspended: vi.fn(),
      getPending: vi.fn(),
      approve: vi.fn(),
    };
    const app = createTestApp({ runRepository, runQueue, checkpointService, approvalManager });

    const response = await request(app)
      .post('/api/runs/run_wait_2/approve')
      .set('x-org-id', 'org_test')
      .set('x-user-id', 'user_test')
      .send({
        tool_call_id: 'tc_wait_2',
        modified_args: ['bad'],
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'modified_args must be an object',
        details: { field: 'modified_args' },
      },
    });
    expect(approvalManager.approve).not.toHaveBeenCalled();
  });
});

