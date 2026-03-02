/**
 * Event type definitions - continued from index.ts
 */

import type {
  BaseEvent,
  RunStartedPayload,
  RunCompletedPayload,
  RunFailedPayload,
  RunResumedPayload,
  RunSuspendedPayload,
  ToolHintPayload,
  ToolCalledPayload,
  ToolResultPayload,
  ToolBlockedPayload,
  ToolRequiresApprovalPayload,
  ToolApprovedPayload,
  ToolRejectedPayload,
  StepStartedPayload,
  StepCompletedPayload,
  LLMCalledPayload,
  LLMTokenPayload,
  MessageTaskPayload,
  MessageProposalPayload,
  MessageDecisionPayload,
  MessageEvidencePayload,
  MessageStatusPayload,
} from './index';

// Specific event types
export interface RunStartedEvent extends BaseEvent {
  type: 'run.started';
  payload: RunStartedPayload;
}

export interface RunCompletedEvent extends BaseEvent {
  type: 'run.completed';
  payload: RunCompletedPayload;
}

export interface RunFailedEvent extends BaseEvent {
  type: 'run.failed';
  payload: RunFailedPayload;
}

export interface RunResumedEvent extends BaseEvent {
  type: 'run.resumed';
  payload: RunResumedPayload;
}

export interface RunSuspendedEvent extends BaseEvent {
  type: 'run.suspended';
  payload: RunSuspendedPayload;
}

export interface ToolCalledEvent extends BaseEvent {
  type: 'tool.called';
  payload: ToolCalledPayload;
}

export interface ToolHintEvent extends BaseEvent {
  type: 'tool.hint';
  payload: ToolHintPayload;
}

export interface ToolResultEvent extends BaseEvent {
  type: 'tool.result';
  payload: ToolResultPayload;
}

export interface ToolBlockedEvent extends BaseEvent {
  type: 'tool.blocked';
  payload: ToolBlockedPayload;
}

export interface ToolRequiresApprovalEvent extends BaseEvent {
  type: 'tool.requires_approval';
  payload: ToolRequiresApprovalPayload;
}

export interface ToolApprovedEvent extends BaseEvent {
  type: 'tool.approved';
  payload: ToolApprovedPayload;
}

export interface ToolRejectedEvent extends BaseEvent {
  type: 'tool.rejected';
  payload: ToolRejectedPayload;
}

export interface StepStartedEvent extends BaseEvent {
  type: 'step.started';
  payload: StepStartedPayload;
}

export interface StepCompletedEvent extends BaseEvent {
  type: 'step.completed';
  payload: StepCompletedPayload;
}

export interface LLMCalledEvent extends BaseEvent {
  type: 'llm.called';
  payload: LLMCalledPayload;
}

export interface LLMTokenEvent extends BaseEvent {
  type: 'llm.token';
  payload: LLMTokenPayload;
}

export interface MessageTaskEvent extends BaseEvent {
  type: 'message.task';
  payload: MessageTaskPayload;
}

export interface MessageProposalEvent extends BaseEvent {
  type: 'message.proposal';
  payload: MessageProposalPayload;
}

export interface MessageDecisionEvent extends BaseEvent {
  type: 'message.decision';
  payload: MessageDecisionPayload;
}

export interface MessageEvidenceEvent extends BaseEvent {
  type: 'message.evidence';
  payload: MessageEvidencePayload;
}

export interface MessageStatusEvent extends BaseEvent {
  type: 'message.status';
  payload: MessageStatusPayload;
}

// Union type for all events
export type Event =
  | RunStartedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunResumedEvent
  | RunSuspendedEvent
  | ToolHintEvent
  | ToolCalledEvent
  | ToolResultEvent
  | ToolBlockedEvent
  | ToolRequiresApprovalEvent
  | ToolApprovedEvent
  | ToolRejectedEvent
  | StepStartedEvent
  | StepCompletedEvent
  | LLMCalledEvent
  | LLMTokenEvent
  | MessageTaskEvent
  | MessageProposalEvent
  | MessageDecisionEvent
  | MessageEvidenceEvent
  | MessageStatusEvent;

// API response types
export interface CreateRunResponse {
  run_id: string;
  status:
    | 'pending'
    | 'running'
    | 'waiting'
    | 'suspended'
    | 'completed'
    | 'failed'
    | 'cancelled';
  created_at: string;
}

export interface ListRunsResponse {
  runs: import('./index').RunMeta[];
  total: number;
  page: number;
  limit: number;
}

export interface GetRunEventsResponse {
  events: Event[];
  total: number;
  next_cursor?: string | null;
}

// Chat message type for UI
export interface ChatMessageAttachment {
  upload_id: string;
  original_name: string;
  mime_type: string;
  size: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  runId?: string;
  attachments?: ChatMessageAttachment[];
}
