import { describe, expect, it, vi } from 'vitest';
import type { RuntimeToolRouter, ToolArgsValidationResult } from './tool-router.js';
import { RunSuspendedError, ToolCallScheduler } from './tool-scheduler.js';

function createApprovalRouter(config: {
  toolName: string;
  firstResult: Record<string, unknown>;
  secondResult?: Record<string, unknown>;
  validation?: ToolArgsValidationResult;
}) {
  const callTool = vi.fn(async () => config.firstResult);
  if (config.secondResult) {
    callTool.mockResolvedValueOnce(config.firstResult).mockResolvedValueOnce(config.secondResult);
  }

  return {
    router: {
      listTools: vi.fn(() => [
        {
          name: config.toolName,
          description: 'tool',
          parameters: {},
          metadata: {
            risk_level: 'high',
            mutating: true,
            supports_parallel: false,
          },
        },
      ]),
      callTool,
      validateToolArgs: vi.fn(() => config.validation ?? { ok: true }),
    } as unknown as RuntimeToolRouter,
    callTool,
  };
}

async function waitForPendingApproval(
  scheduler: ToolCallScheduler,
  toolCallId: string
): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (scheduler.approvalManager.getPending(toolCallId)) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Pending approval not found for ${toolCallId}`);
}

describe('ToolCallScheduler', () => {
  it('throws RunSuspendedError immediately for requiresApproval tools in checkpoint mode', async () => {
    const scheduler = new ToolCallScheduler();
    const onSuspend = vi.fn(async () => undefined);
    const { router } = createApprovalRouter({
      toolName: 'exec_command',
      firstResult: {
        success: false,
        error: 'Requires approval',
        duration: 1,
        requiresApproval: true,
        policyReason: 'high-risk execution',
        riskLevel: 'high',
      },
    });

    await expect(
      scheduler.executeBatch(
        [
          {
            id: 'tc_approval',
            name: 'exec_command',
            parameters: { command: 'rm -rf /tmp/test' },
          },
        ],
        router,
        {
          runId: 'run_test',
          sessionKey: 's_test',
          agentId: 'main',
          stepId: 'step_0001',
          rootSpan: 'sp_root',
          onSuspend,
        }
      )
    ).rejects.toBeInstanceOf(RunSuspendedError);

    expect(onSuspend).toHaveBeenCalledTimes(1);
    expect(onSuspend).toHaveBeenCalledWith('high-risk execution');
    expect(scheduler.approvalManager.getPending('tc_approval')).toBeUndefined();
  });

  it('uses full-override args after approval in waiting mode and marks human intervention', async () => {
    const scheduler = new ToolCallScheduler();
    const { router, callTool } = createApprovalRouter({
      toolName: 'exec_command',
      firstResult: {
        success: false,
        error: 'Requires approval',
        duration: 1,
        requiresApproval: true,
        policyReason: 'high-risk execution',
        riskLevel: 'high',
      },
      secondResult: {
        success: true,
        result: { stdout: 'ok' },
        duration: 2,
      },
    });

    const execution = scheduler.executeBatch(
      [
        {
          id: 'tc_wait_1',
          name: 'exec_command',
          parameters: { command: 'rm -rf /', recursive: true },
        },
      ],
      router,
      {
        runId: 'run_wait_1',
        sessionKey: 's_wait',
        agentId: 'main',
        stepId: 'step_0001',
        rootSpan: 'sp_root',
      }
    );
    await waitForPendingApproval(scheduler, 'tc_wait_1');
    scheduler.approvalManager.approve('tc_wait_1', { command: 'ls -l /' });
    const batch = await execution;

    expect(callTool).toHaveBeenCalledTimes(2);
    const secondCall = callTool.mock.calls[1] as unknown[] | undefined;
    expect(secondCall?.[1]).toEqual({ command: 'ls -l /' });

    const result = batch.results[0]?.result;
    expect(result?.success).toBe(true);
    expect(result?.humanInterventionNote).toContain('modified them to');

    const modifiedCallEvent = batch.events.find(
      (event) => event.type === 'tool.called'
        && (event.payload as { human_intervened?: boolean }).human_intervened === true
    );
    expect(modifiedCallEvent).toBeDefined();

    const approvedEvent = batch.events.find((event) => event.type === 'tool.approved');
    expect(approvedEvent).toBeDefined();
    expect(approvedEvent?.payload).toMatchObject({
      tool_call_id: 'tc_wait_1',
      modified_args_applied: true,
      modified_args: { command: 'ls -l /' },
    });
  });

  it('returns tool error when full-override args fail runtime schema validation', async () => {
    const scheduler = new ToolCallScheduler();
    const { router, callTool } = createApprovalRouter({
      toolName: 'exec_command',
      firstResult: {
        success: false,
        error: 'Requires approval',
        duration: 1,
        requiresApproval: true,
        policyReason: 'high-risk execution',
        riskLevel: 'high',
      },
      validation: {
        ok: false,
        message: "/ must have required property 'command'",
        errors: [],
      },
    });

    const execution = scheduler.executeBatch(
      [
        {
          id: 'tc_wait_invalid',
          name: 'exec_command',
          parameters: { command: 'echo hi' },
        },
      ],
      router,
      {
        runId: 'run_wait_2',
        sessionKey: 's_wait',
        agentId: 'main',
        stepId: 'step_0002',
        rootSpan: 'sp_root',
      }
    );
    await waitForPendingApproval(scheduler, 'tc_wait_invalid');
    scheduler.approvalManager.approve('tc_wait_invalid', { cwd: '/tmp' });
    const batch = await execution;

    expect(callTool).toHaveBeenCalledTimes(1);
    const result = batch.results[0]?.result;
    expect(result?.success).toBe(false);
    expect(result?.error).toContain('Invalid tool arguments');
    expect(result?.humanInterventionNote).toContain('modified them to');
  });
});

