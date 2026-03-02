import { describe, expect, it, vi } from 'vitest';
import type { RunQueue } from '../../queue/run-queue.js';
import type { RunRecord } from '../../runtime/models.js';
import type { RunRepository } from '@openintern/repository';
import type { FeishuClient } from '../../runtime/integrations/feishu/client.js';
import { FeishuImService } from './im-service.js';

function makeRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run_test_1',
    orgId: 'org_feishu',
    userId: 'user_feishu',
    projectId: 'proj_feishu',
    groupId: null,
    sessionKey: 's_feishu_oc_123',
    input: 'hello',
    status: 'pending',
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
    ...overrides,
  };
}

async function waitForCalls(fn: { mock: { calls: unknown[] } }, minCalls: number): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (fn.mock.calls.length >= minCalls) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('FeishuImService', () => {
  it('responds to url_verification challenge', async () => {
    const runRepository = {
      createRun: vi.fn(async () => makeRunRecord()),
      getRunById: vi.fn(async () => makeRunRecord()),
    } as unknown as RunRepository;
    const runQueue = { enqueue: vi.fn() } as unknown as RunQueue;
    const feishuClient = { sendTextMessage: vi.fn(async () => undefined) } as unknown as FeishuClient;

    const service = new FeishuImService(runRepository, runQueue, feishuClient, {
      enabled: true,
      verifyToken: 'token_123',
      defaultOrgId: 'org_feishu',
    });

    const result = await service.handleWebhook({
      type: 'url_verification',
      token: 'token_123',
      challenge: 'challenge_abc',
    });

    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ challenge: 'challenge_abc' });
  });

  it('creates run from text message and sends reply on completion', async () => {
    const createRun = vi.fn(async () => makeRunRecord());
    const getRunById = vi.fn(async () =>
      makeRunRecord({
        status: 'completed',
        result: { output: 'assistant reply' },
      })
    );
    const runRepository = { createRun, getRunById } as unknown as RunRepository;
    const enqueue = vi.fn();
    const runQueue = { enqueue } as unknown as RunQueue;
    const sendTextMessage = vi.fn(async () => undefined);
    const feishuClient = { sendTextMessage } as unknown as FeishuClient;

    const service = new FeishuImService(runRepository, runQueue, feishuClient, {
      enabled: true,
      defaultOrgId: 'org_feishu',
      defaultProjectId: 'proj_feishu',
      defaultUserId: 'user_feishu',
      waitTimeoutMs: 3000,
      pollIntervalMs: 10,
    });

    const result = await service.handleWebhook({
      type: 'event_callback',
      header: {
        event_type: 'im.message.receive_v1',
        tenant_key: 'tenant_foo',
      },
      event: {
        sender: {
          sender_type: 'user',
          sender_id: {
            open_id: 'ou_foo',
          },
        },
        message: {
          message_id: 'om_msg_1',
          chat_id: 'oc_chat_1',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: 'hello from feishu' }),
        },
      },
    });

    expect(result.statusCode).toBe(200);
    expect(createRun).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);

    await waitForCalls(sendTextMessage, 1);
    expect(sendTextMessage).toHaveBeenCalledWith({
      receiveIdType: 'chat_id',
      receiveId: 'oc_chat_1',
      text: 'assistant reply',
    });
  });
});


