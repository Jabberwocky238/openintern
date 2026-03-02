import { describe, expect, it, vi } from 'vitest';
import type { Event } from '../../../types/events.js';
import type { QueuedRun } from '../../../types/api.js';
import { executeSingleRun } from './single-run.js';

describe('executeSingleRun', () => {
  it('resumes from checkpoint and emits run.resumed with injected tool-result context', async () => {
    const writtenEvents: Event[] = [];
    const runRepository = {
      setRunWaiting: vi.fn(async () => undefined),
      setRunResumed: vi.fn(async () => undefined),
      setRunSuspended: vi.fn(async () => undefined),
      setRunCompleted: vi.fn(async () => undefined),
      setRunFailed: vi.fn(async () => undefined),
      setRunCancelled: vi.fn(async () => undefined),
      listSessionHistory: vi.fn(async () => []),
      getRunById: vi.fn(async () => ({
        id: 'run_resume_1',
        orgId: 'org_test',
        userId: 'user_test',
        projectId: null,
        groupId: null,
        sessionKey: 's_resume',
        input: 'resume work',
        status: 'running',
        agentId: 'main',
        llmConfig: null,
        result: null,
        error: null,
        parentRunId: null,
        delegatedPermissions: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        endedAt: null,
        cancelledAt: null,
        suspendedAt: null,
        suspendReason: null,
      })),
    };
    const config = {
      runRepository,
      eventService: {
        write: vi.fn(async (event: Event) => {
          writtenEvents.push(event);
        }),
        writeBatch: vi.fn(async () => undefined),
      },
      checkpointService: {
        loadLatest: vi.fn(async () => ({
          stepId: 'step_0001',
          stepNumber: 1,
          messages: [
            { role: 'user' as const, content: 'do dangerous thing' },
            {
              role: 'assistant' as const,
              content: 'requesting approval',
              toolCalls: [{ id: 'tc_approve_1', name: 'exec_shell', parameters: { command: 'rm -rf /tmp/x' } }],
            },
            {
              role: 'tool' as const,
              toolCallId: 'tc_approve_1',
              content: '{"approved":true,"tool_call_id":"tc_approve_1"}',
            },
          ],
          workingState: { plan: 'single-agent-loop' },
        })),
        save: vi.fn(async () => undefined),
      },
      memoryService: {
        memory_search_pa: vi.fn(async () => []),
        memory_search_tiered: vi.fn(async () => []),
      },
      sseManager: {
        broadcastToRun: vi.fn(),
      },
      groupRepository: {
        listGroupsWithRoles: vi.fn(async () => []),
      },
      roleRepository: {
        getRoleByAgentId: vi.fn(async () => null),
      },
      maxSteps: 3,
      workDir: '/tmp',
      persistLlmTokens: false,
    };

    const run: QueuedRun = {
      run_id: 'run_resume_1',
      org_id: 'org_test',
      user_id: 'user_test',
      session_key: 's_resume',
      input: 'resume work',
      agent_id: 'main',
      created_at: new Date().toISOString(),
      status: 'pending',
    };
    const signal = new AbortController().signal;
    const status = await executeSingleRun(
      config as never,
      run,
      { orgId: 'org_test', userId: 'user_test', projectId: null },
      { provider: 'mock', model: 'mock-model' },
      {
        listTools: vi.fn(() => []),
        listSkills: vi.fn(() => []),
        callTool: vi.fn(async () => ({ success: true, result: {}, duration: 1 })),
      } as never,
      signal
    );

    expect(status).toBe('completed');
    expect(config.checkpointService.loadLatest).toHaveBeenCalledWith('run_resume_1', 'main');
    expect(writtenEvents.length).toBeGreaterThan(0);
    expect(writtenEvents[0]?.type).toBe('run.resumed');
    expect(writtenEvents.some((event) => event.type === 'run.completed')).toBe(true);
  });
});

