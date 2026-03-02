import type { Message } from '../../types/agent.js';
import type { IRunRepository } from '@openintern/repository';

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
  if (!value || typeof value !== 'object') {
    return value;
  }
  const cleaned: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'messages') {
      continue;
    }
    cleaned[key] = stripMessagesField(val);
  }
  return cleaned;
}

export class CheckpointService {
  constructor(private readonly runs: IRunRepository) {}

  async save(
    runId: string,
    agentId: string,
    stepId: string,
    messages: Message[],
    lastSavedCount: number,
    workingState: Record<string, unknown>
  ): Promise<void> {
    const newMessages = messages.slice(lastSavedCount).map((message) => ({
      role: message.role,
      content: message.content as unknown,
      ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
      ...(message.toolCalls !== undefined ? { toolCalls: message.toolCalls as unknown } : {}),
    }));
    const slim: SlimCheckpointState = {
      step_id: stepId,
      step_number: Number.parseInt(stepId.replace('step_', ''), 10),
      message_count: messages.length,
      working_state: this.sanitizeWorkingState(workingState),
    };

    await this.runs.saveCheckpointSnapshot({
      runId,
      agentId,
      stepId,
      messages: newMessages,
      startOrdinal: lastSavedCount,
      state: slim as unknown as Record<string, unknown>,
    });
  }

  async appendToolResults(
    runId: string,
    agentId: string,
    messages: Array<{ role: 'tool'; content: unknown; toolCallId: string }>
  ): Promise<void> {
    const checkpoint = await this.runs.getLatestCheckpoint(runId, agentId);
    if (!checkpoint) {
      throw new Error(`No checkpoint found for run ${runId}`);
    }
    const state = checkpoint.state as unknown as SlimCheckpointState;
    const nextState: SlimCheckpointState = {
      ...state,
      message_count: state.message_count + messages.length,
    };

    await this.runs.saveCheckpointSnapshot({
      runId,
      agentId,
      stepId: state.step_id,
      messages,
      startOrdinal: state.message_count,
      state: nextState as unknown as Record<string, unknown>,
    });
  }

  async loadLatest(runId: string, agentId: string): Promise<LoadedCheckpoint | null> {
    const checkpoint = await this.runs.getLatestCheckpoint(runId, agentId);
    if (!checkpoint) {
      return null;
    }
    const state = checkpoint.state as unknown as SlimCheckpointState;
    const rows = await this.runs.loadMessages(runId, agentId);
    const messages: Message[] = rows.map((row) => ({
      role: row.role as Message['role'],
      content: row.content as Message['content'],
      ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
      ...(row.toolCalls ? { toolCalls: row.toolCalls as Message['toolCalls'] } : {}),
    }));
    return {
      stepId: checkpoint.stepId,
      stepNumber: state.step_number ?? 0,
      messages,
      workingState: state.working_state ?? {},
    };
  }

  private sanitizeWorkingState(state: Record<string, unknown>): Record<string, unknown> {
    return stripMessagesField(state) as Record<string, unknown>;
  }
}

