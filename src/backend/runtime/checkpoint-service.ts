import type { Pool } from 'pg';
import type { Message } from '../../types/agent.js';
import { RunRepository } from '../repository/postgres/run-repository.js';

export interface SlimCheckpointState {
  step_id: string;
  step_number: number;
  message_count: number;
  working_state: Record<string, unknown>;
}

export interface LoadedCheckpoint {
  stepId: string;
  stepNumber: number;
  messages: Message[];
  workingState: Record<string, unknown>;
}

function stripMessagesField(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripMessagesField);
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(record)) {
      if (key === 'messages') continue;
      cleaned[key] = stripMessagesField(val);
    }
    return cleaned;
  }
  return value;
}

export class CheckpointService {
  constructor(
    private readonly runs: RunRepository,
    private readonly pool: Pool
  ) {}

  async save(
    runId: string,
    agentId: string,
    stepId: string,
    messages: Message[],
    lastSavedCount: number,
    workingState: Record<string, unknown>
  ): Promise<void> {
    const newMessages = messages.slice(lastSavedCount);
    const sanitizedWorkingState = this.sanitizeWorkingState(workingState);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (newMessages.length > 0) {
        const mapped = newMessages.map((m) => ({
          role: m.role,
          content: m.content as unknown,
          ...(m.toolCallId !== undefined ? { toolCallId: m.toolCallId } : {}),
          ...(m.toolCalls !== undefined ? { toolCalls: m.toolCalls as unknown } : {}),
        }));
        await this.runs.appendMessages(
          runId, agentId, stepId, mapped, lastSavedCount, client
        );
      }
      const slim: SlimCheckpointState = {
        step_id: stepId,
        step_number: parseInt(stepId.replace('step_', ''), 10),
        message_count: messages.length,
        working_state: sanitizedWorkingState,
      };
      await this.runs.createCheckpoint(
        runId, agentId, stepId, slim as unknown as Record<string, unknown>, client
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Append tool-result messages to an existing checkpoint (used by SwarmCoordinator
   * to inject child results before waking a suspended parent).
   */
  async appendToolResults(
    runId: string,
    agentId: string,
    messages: Array<{ role: 'tool'; content: unknown; toolCallId: string }>
  ): Promise<void> {
    const cp = await this.runs.getLatestCheckpoint(runId, agentId);
    if (!cp) throw new Error(`No checkpoint found for run ${runId}`);
    const state = cp.state as unknown as SlimCheckpointState;
    const startOrdinal = state.message_count;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.runs.appendMessages(
        runId, agentId, state.step_id, messages, startOrdinal, client
      );
      const newState: SlimCheckpointState = {
        ...state,
        message_count: startOrdinal + messages.length,
      };
      await this.runs.createCheckpoint(
        runId, agentId, state.step_id,
        newState as unknown as Record<string, unknown>,
        client
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async loadLatest(
    runId: string,
    agentId: string
  ): Promise<LoadedCheckpoint | null> {
    const cp = await this.runs.getLatestCheckpoint(runId, agentId);
    if (!cp) return null;
    const state = cp.state as unknown as SlimCheckpointState;
    const rows = await this.runs.loadMessages(runId, agentId);
    const messages: Message[] = rows.map((r) => ({
      role: r.role as Message['role'],
      content: r.content as Message['content'],
      ...(r.toolCallId ? { toolCallId: r.toolCallId } : {}),
      ...(r.toolCalls ? { toolCalls: r.toolCalls as Message['toolCalls'] } : {}),
    }));
    return {
      stepId: cp.stepId,
      stepNumber: state.step_number ?? 0,
      messages,
      workingState: state.working_state ?? {},
    };
  }

  private sanitizeWorkingState(
    state: Record<string, unknown>
  ): Record<string, unknown> {
    return stripMessagesField(state) as Record<string, unknown>;
  }
}
