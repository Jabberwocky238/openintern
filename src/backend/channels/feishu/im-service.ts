import type { QueuedRun } from '../../../types/api.js';
import type { RunStatus } from '../../runtime/models.js';
import type { IRunRepository } from '@openintern/repository';
import type { RunQueue } from '../../queue/run-queue.js';
import type { FeishuClient, FeishuMessageReceiveIdType } from '../../runtime/integrations/feishu/client.js';
import { generateRunId } from '../../../utils/ids.js';
import { logger } from '../../../utils/logger.js';

interface FeishuWebhookResult {
  statusCode: number;
  body: Record<string, unknown>;
}

interface FeishuWebhookEnvelope {
  type: string | null;
  header: Record<string, unknown>;
  event: Record<string, unknown>;
}

interface FeishuMessageEvent {
  messageId: string;
  chatId: string;
  chatType: string;
  messageType: string;
  text: string | null;
  senderType: string;
  senderOpenId: string | null;
  senderUserId: string | null;
  senderUnionId: string | null;
  tenantKey: string | null;
}

interface FeishuImRunOutcome {
  status: RunStatus | 'timeout';
  output: string | null;
  errorMessage: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function sanitizeForSession(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, '_');
}

function normalizeTextContent(text: string): string {
  const withoutMentions = text.replace(/<at\s+user_id="[^"]+">[^<]*<\/at>/g, '').trim();
  return withoutMentions;
}

function parseTextMessage(rawContent: string | null): string | null {
  if (!rawContent) {
    return null;
  }
  try {
    const parsed = asRecord(JSON.parse(rawContent) as unknown);
    const text = readString(parsed['text']);
    return text ? normalizeTextContent(text) : null;
  } catch {
    return null;
  }
}

function extractOutput(result: Record<string, unknown> | null): string | null {
  if (!result || typeof result !== 'object') {
    return null;
  }
  const output = result['output'];
  return readString(output);
}

function extractErrorMessage(error: Record<string, unknown> | null): string | null {
  if (!error || typeof error !== 'object') {
    return null;
  }
  return readString(error['message']) ?? readString(error['code']);
}

function resolveReceiveId(
  chatType: string,
  chatId: string,
  senderOpenId: string | null
): { receiveIdType: FeishuMessageReceiveIdType; receiveId: string | null } {
  if (chatType === 'group') {
    return { receiveIdType: 'chat_id', receiveId: chatId };
  }
  return { receiveIdType: 'open_id', receiveId: senderOpenId ?? chatId };
}

function composeReply(outcome: FeishuImRunOutcome): string {
  if (outcome.status === 'completed') {
    return outcome.output ?? 'Run completed without textual output.';
  }
  if (outcome.status === 'failed') {
    const message = outcome.errorMessage ?? 'Unknown error';
    return `Run failed: ${message}`;
  }
  if (outcome.status === 'cancelled') {
    return 'Run was cancelled.';
  }
  if (outcome.status === 'suspended') {
    return 'Run is suspended and waiting for human approval in Inbox.';
  }
  return 'Run is still processing. Please check OpenIntern Runs for the final result.';
}

export interface FeishuImServiceConfig {
  enabled: boolean;
  defaultOrgId?: string;
  defaultUserId?: string;
  defaultProjectId?: string;
  defaultAgentId?: string;
  sessionPrefix?: string;
  verifyToken?: string;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
}

export class FeishuImService {
  private readonly processedMessages = new Map<string, number>();
  private readonly dedupTtlMs = 10 * 60 * 1000;
  private readonly dedupMaxSize = 2048;
  private readonly waitTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly sessionPrefix: string;
  private readonly defaultAgentId: string;

  constructor(
    private readonly runRepository: IRunRepository,
    private readonly runQueue: RunQueue,
    private readonly feishuClient: FeishuClient | null,
    private readonly config: FeishuImServiceConfig
  ) {
    this.waitTimeoutMs = Math.max(3000, config.waitTimeoutMs ?? 90000);
    this.pollIntervalMs = Math.max(200, config.pollIntervalMs ?? 600);
    const normalizedPrefix = sanitizeForSession(config.sessionPrefix ?? 's_feishu');
    this.sessionPrefix = normalizedPrefix.startsWith('s_')
      ? normalizedPrefix
      : `s_${normalizedPrefix}`;
    this.defaultAgentId = config.defaultAgentId ?? 'main';
  }

  async handleWebhook(payload: unknown): Promise<FeishuWebhookResult> {
    const envelope = this.parseWebhookEnvelope(payload);
    if (envelope.type === 'url_verification') {
      return this.handleUrlVerification(payload);
    }

    if (envelope.type !== 'event_callback') {
      return {
        statusCode: 200,
        body: { code: 0, msg: 'ignored' },
      };
    }

    const eventType = readString(envelope.header['event_type']);
    if (eventType !== 'im.message.receive_v1') {
      return {
        statusCode: 200,
        body: { code: 0, msg: 'ignored' },
      };
    }

    const messageEvent = this.parseMessageEvent(envelope);
    if (!messageEvent) {
      return {
        statusCode: 200,
        body: { code: 0, msg: 'ignored' },
      };
    }

    if (!this.shouldHandleMessage(messageEvent)) {
      return {
        statusCode: 200,
        body: { code: 0, msg: 'ignored' },
      };
    }

    if (!this.config.enabled || !this.feishuClient) {
      logger.warn('Feishu IM event received but IM service is disabled');
      return {
        statusCode: 200,
        body: { code: 0, msg: 'ignored' },
      };
    }

    const scope = this.resolveScope(messageEvent);
    if (!scope.orgId || !scope.userId) {
      logger.error('Feishu IM scope is not configured; skip run creation', {
        orgId: scope.orgId,
        userId: scope.userId,
      });
      return {
        statusCode: 200,
        body: { code: 0, msg: 'ignored' },
      };
    }

    const runId = generateRunId();
    const sessionKey = this.buildSessionKey(messageEvent.chatId);
    try {
      const created = await this.runRepository.createRun({
        id: runId,
        scope: {
          orgId: scope.orgId,
          userId: scope.userId,
          projectId: scope.projectId,
        },
        sessionKey,
        input: messageEvent.text ?? '',
        agentId: this.defaultAgentId,
        llmConfig: null,
      });

      const queuedRun: QueuedRun = {
        run_id: created.id,
        org_id: created.orgId,
        user_id: created.userId,
        ...(created.projectId ? { project_id: created.projectId } : {}),
        session_key: created.sessionKey,
        input: created.input,
        agent_id: created.agentId,
        created_at: created.createdAt,
        status: 'pending',
      };
      this.runQueue.enqueue(queuedRun);

      const target = resolveReceiveId(
        messageEvent.chatType,
        messageEvent.chatId,
        messageEvent.senderOpenId
      );

      if (target.receiveId) {
        void this.waitAndReply(runId, target.receiveIdType, target.receiveId);
      }
    } catch (error) {
      logger.error('Failed to enqueue Feishu IM run', {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      statusCode: 200,
      body: { code: 0, msg: 'ok' },
    };
  }

  private parseWebhookEnvelope(payload: unknown): FeishuWebhookEnvelope {
    const root = asRecord(payload);
    return {
      type: readString(root['type']),
      header: asRecord(root['header']),
      event: asRecord(root['event']),
    };
  }

  private handleUrlVerification(payload: unknown): FeishuWebhookResult {
    const root = asRecord(payload);
    const token = readString(root['token']);
    if (this.config.verifyToken && token !== this.config.verifyToken) {
      return {
        statusCode: 403,
        body: { code: 403, msg: 'verification token mismatch' },
      };
    }
    const challenge = readString(root['challenge']) ?? '';
    return {
      statusCode: 200,
      body: { challenge },
    };
  }

  private parseMessageEvent(envelope: FeishuWebhookEnvelope): FeishuMessageEvent | null {
    const message = asRecord(envelope.event['message']);
    const sender = asRecord(envelope.event['sender']);
    const senderId = asRecord(sender['sender_id']);
    const messageId = readString(message['message_id']);
    const chatId = readString(message['chat_id']);
    const chatType = readString(message['chat_type']);
    const messageType = readString(message['message_type']);
    if (!messageId || !chatId || !chatType || !messageType) {
      return null;
    }

    const senderType = readString(sender['sender_type']) ?? 'user';
    const text = messageType === 'text'
      ? parseTextMessage(readString(message['content']))
      : null;

    return {
      messageId,
      chatId,
      chatType,
      messageType,
      text,
      senderType,
      senderOpenId: readString(senderId['open_id']),
      senderUserId: readString(senderId['user_id']),
      senderUnionId: readString(senderId['union_id']),
      tenantKey: readString(envelope.header['tenant_key']) ?? readString(sender['tenant_key']),
    };
  }

  private shouldHandleMessage(event: FeishuMessageEvent): boolean {
    this.cleanupDedupCache();
    if (this.processedMessages.has(event.messageId)) {
      return false;
    }
    this.processedMessages.set(event.messageId, Date.now());
    if (this.processedMessages.size > this.dedupMaxSize) {
      const firstKey = this.processedMessages.keys().next().value;
      if (firstKey) {
        this.processedMessages.delete(firstKey);
      }
    }

    if (event.senderType === 'bot') {
      return false;
    }
    if (event.messageType !== 'text') {
      return false;
    }
    if (!event.text || event.text.length === 0) {
      return false;
    }
    return true;
  }

  private cleanupDedupCache(): void {
    const now = Date.now();
    for (const [messageId, ts] of this.processedMessages.entries()) {
      if (now - ts > this.dedupTtlMs) {
        this.processedMessages.delete(messageId);
      }
    }
  }

  private resolveScope(event: FeishuMessageEvent): {
    orgId: string | null;
    userId: string | null;
    projectId: string | null;
  } {
    const orgId = this.config.defaultOrgId ?? event.tenantKey;
    const userId = this.config.defaultUserId
      ?? event.senderOpenId
      ?? event.senderUserId
      ?? event.senderUnionId;
    const projectId = this.config.defaultProjectId ?? null;
    return { orgId, userId, projectId };
  }

  private buildSessionKey(chatId: string): string {
    return `${this.sessionPrefix}_${sanitizeForSession(chatId)}`;
  }

  private async waitAndReply(
    runId: string,
    receiveIdType: FeishuMessageReceiveIdType,
    receiveId: string
  ): Promise<void> {
    const outcome = await this.waitForRunOutcome(runId);
    const text = composeReply(outcome);
    try {
      await this.feishuClient?.sendTextMessage({
        receiveIdType,
        receiveId,
        text,
      });
    } catch (error) {
      logger.error('Failed to send Feishu IM reply', {
        runId,
        receiveIdType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async waitForRunOutcome(runId: string): Promise<FeishuImRunOutcome> {
    const start = Date.now();
    for (;;) {
      const run = await this.runRepository.getRunById(runId);
      if (run) {
        if (run.status === 'completed') {
          return {
            status: run.status,
            output: extractOutput(run.result),
            errorMessage: null,
          };
        }
        if (run.status === 'failed' || run.status === 'cancelled' || run.status === 'suspended') {
          return {
            status: run.status,
            output: null,
            errorMessage: extractErrorMessage(run.error),
          };
        }
      }

      if (Date.now() - start >= this.waitTimeoutMs) {
        return {
          status: 'timeout',
          output: null,
          errorMessage: null,
        };
      }
      await delay(this.pollIntervalMs);
    }
  }
}







