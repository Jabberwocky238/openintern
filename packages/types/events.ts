import { z } from 'zod';

/**
 * Base event schema - common fields for all events
 */
export const BaseEventSchema = z.object({
  /** Schema version */
  v: z.literal(1),
  /** Timestamp in ISO 8601 format */
  ts: z.string().datetime(),
  /** Session identifier */
  session_key: z.string().regex(/^s_[a-zA-Z0-9_]+$/),
  /** Run identifier */
  run_id: z.string().regex(/^run_[a-zA-Z0-9]+$/),
  /** Agent identifier */
  agent_id: z.string().min(1),
  /** Step identifier */
  step_id: z.string().regex(/^step_[0-9]+$/),
  /** Span identifier for tracing */
  span_id: z.string().regex(/^sp_[a-zA-Z0-9]+$/),
  /** Parent span identifier (null for root spans) */
  parent_span_id: z.string().regex(/^sp_[a-zA-Z0-9]+$/).nullable(),
  /** Redaction metadata */
  redaction: z.object({
    contains_secrets: z.boolean(),
  }),
  /** Group identifier (multi-role orchestration) */
  group_id: z.string().min(1).optional(),
  /** Structured message type (multi-role orchestration) */
  message_type: z.enum(['TASK', 'PROPOSAL', 'DECISION', 'EVIDENCE', 'STATUS']).optional(),
  /** Target agent identifier */
  to_agent_id: z.string().min(1).optional(),
  /** Artifact references */
  artifact_refs: z.array(z.object({
    type: z.string(),
    id: z.string(),
  })).optional(),
});

export type BaseEvent = z.infer<typeof BaseEventSchema>;

/**
 * Run started event payload
 */
export const RunStartedPayloadSchema = z.object({
  input: z.string(),
  config: z.record(z.unknown()).optional(),
});

/**
 * Run completed event payload
 */
export const RunCompletedPayloadSchema = z.object({
  output: z.string(),
  duration_ms: z.number().nonnegative(),
});

/**
 * Run failed event payload
 */
export const RunFailedPayloadSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
  }),
});

/**
 * Tool called event payload
 */
export const ToolCalledPayloadSchema = z.object({
  toolName: z.string(),
  args: z.record(z.unknown()),
  tool_call_id: z.string().optional(),
  human_intervened: z.boolean().optional(),
  modified_args_applied: z.boolean().optional(),
  effective_args: z.record(z.unknown()).optional(),
});

/**
 * Tool hint event payload
 */
export const ToolHintPayloadSchema = z.object({
  hint: z.string(),
  tools: z.array(z.string()).default([]),
  tool_count: z.number().positive(),
});

/**
 * Tool result event payload
 */
export const ToolResultPayloadSchema = z.object({
  toolName: z.string(),
  result: z.unknown(),
  isError: z.boolean(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});

/**
 * Tool blocked event payload - tool call denied by policy
 */
export const ToolBlockedPayloadSchema = z.object({
  toolName: z.string(),
  args: z.record(z.unknown()),
  reason: z.string(),
  role_id: z.string().optional(),
  risk_level: z.string().optional(),
});

/**
 * Tool requires approval event payload - tool call needs human approval
 */
export const ToolRequiresApprovalPayloadSchema = z.object({
  toolName: z.string(),
  tool_call_id: z.string(),
  args: z.record(z.unknown()),
  reason: z.string(),
  role_id: z.string().optional(),
  risk_level: z.string().optional(),
});

/**
 * Tool approved event payload - user approved a tool call
 */
export const ToolApprovedPayloadSchema = z.object({
  toolName: z.string(),
  tool_call_id: z.string(),
  modified_args: z.record(z.unknown()).optional(),
  modified_args_applied: z.boolean().optional(),
});

/**
 * Tool rejected event payload - user rejected a tool call
 */
export const ToolRejectedPayloadSchema = z.object({
  toolName: z.string(),
  tool_call_id: z.string(),
  reason: z.string().optional(),
});

/**
 * Step started event payload
 */
export const StepStartedPayloadSchema = z.object({
  stepNumber: z.number().nonnegative(),
});

/**
 * Step completed event payload
 */
export const StepCompletedPayloadSchema = z.object({
  stepNumber: z.number().nonnegative(),
  resultType: z.enum(['tool_call', 'final_answer', 'continue']),
  duration_ms: z.number().nonnegative(),
});

/**
 * LLM called event payload
 */
export const LLMCalledPayloadSchema = z.object({
  model: z.string(),
  promptTokens: z.number().nonnegative(),
  completionTokens: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(),
  duration_ms: z.number().nonnegative(),
});

/**
 * Run resumed event payload
 */
export const RunResumedPayloadSchema = z.object({
  checkpoint_step_id: z.string(),
  orphaned_tool_calls: z.number().nonnegative(),
});

/**
 * Run suspended event payload
 */
export const RunSuspendedPayloadSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  reason: z.string(),
});

/**
 * Step retried event payload
 */
export const StepRetriedPayloadSchema = z.object({
  stepNumber: z.number().nonnegative(),
  attempt: z.number().positive(),
  reason: z.string(),
  delayMs: z.number().nonnegative(),
});

/**
 * LLM token streaming event payload
 */
export const LLMTokenPayloadSchema = z.object({
  token: z.string(),
  tokenIndex: z.number().nonnegative(),
});

// ─── Structured Message Payloads (Multi-role Orchestration) ──

/**
 * TASK message payload - assign a task to an agent
 */
export const TaskMessagePayloadSchema = z.object({
  goal: z.string(),
  inputs: z.record(z.unknown()).default({}),
  expected_output: z.string().optional(),
  constraints: z.array(z.string()).default([]),
  priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
});

/**
 * PROPOSAL message payload - agent proposes a plan
 */
export const ProposalMessagePayloadSchema = z.object({
  plan: z.string(),
  risks: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  evidence_refs: z.array(z.object({ type: z.string(), id: z.string() })).default([]),
});

/**
 * DECISION message payload - lead makes a decision
 */
export const DecisionMessagePayloadSchema = z.object({
  decision: z.string(),
  rationale: z.string(),
  next_actions: z.array(z.string()).default([]),
  evidence_refs: z.array(z.object({ type: z.string(), id: z.string() })).default([]),
});

/**
 * EVIDENCE message payload - agent provides evidence
 */
export const EvidenceMessagePayloadSchema = z.object({
  refs: z.array(z.object({ type: z.string(), id: z.string() })),
  summary: z.string(),
});

/**
 * STATUS message payload - agent reports status
 */
export const StatusMessagePayloadSchema = z.object({
  state: z.enum(['working', 'blocked', 'done', 'error']),
  progress: z.number().min(0).max(1).optional(),
  blockers: z.array(z.string()).default([]),
});

// ─── Tool Batch Events ───────────────────────────────────────

export const ToolBatchStartedPayloadSchema = z.object({
  batch_id: z.string(),
  tool_count: z.number().nonnegative(),
  strategy: z.enum(['parallel', 'serial']),
});

export const ToolBatchCompletedPayloadSchema = z.object({
  batch_id: z.string(),
  tool_count: z.number().nonnegative(),
  success_count: z.number().nonnegative(),
  failure_count: z.number().nonnegative(),
  duration_ms: z.number().nonnegative(),
});

// ─── Run Compacted Event ─────────────────────────────────────

export const RunCompactedPayloadSchema = z.object({
  messages_before: z.number().nonnegative(),
  messages_after: z.number().nonnegative(),
  tokens_saved: z.number().nonnegative(),
});

// ─── Run Warning Event ───────────────────────────────────────

export const RunWarningPayloadSchema = z.object({
  code: z.string(),
  message: z.string(),
  context: z.record(z.unknown()).optional(),
});

// ─── MCP Tools Refreshed Event ───────────────────────────────

export const McpToolsRefreshedPayloadSchema = z.object({
  server: z.string(),
  tool_count: z.number().nonnegative(),
  added: z.array(z.string()).default([]),
  removed: z.array(z.string()).default([]),
});

/**
 * Event type enum
 */
export const EventTypeSchema = z.enum([
  'run.started',
  'run.completed',
  'run.failed',
  'run.resumed',
  'run.suspended',
  'run.compacted',
  'run.warning',
  'step.started',
  'step.completed',
  'step.retried',
  'llm.called',
  'llm.token',
  'tool.hint',
  'tool.called',
  'tool.result',
  'tool.blocked',
  'tool.requires_approval',
  'tool.approved',
  'tool.rejected',
  'tool.batch.started',
  'tool.batch.completed',
  'mcp.tools.refreshed',
  'message.task',
  'message.proposal',
  'message.decision',
  'message.evidence',
  'message.status',
]);

export type EventType = z.infer<typeof EventTypeSchema>;

/**
 * Run started event
 */
export const RunStartedEventSchema = BaseEventSchema.extend({
  type: z.literal('run.started'),
  payload: RunStartedPayloadSchema,
});

export type RunStartedEvent = z.infer<typeof RunStartedEventSchema>;

/**
 * Run completed event
 */
export const RunCompletedEventSchema = BaseEventSchema.extend({
  type: z.literal('run.completed'),
  payload: RunCompletedPayloadSchema,
});

export type RunCompletedEvent = z.infer<typeof RunCompletedEventSchema>;

/**
 * Run failed event
 */
export const RunFailedEventSchema = BaseEventSchema.extend({
  type: z.literal('run.failed'),
  payload: RunFailedPayloadSchema,
});

export type RunFailedEvent = z.infer<typeof RunFailedEventSchema>;

/**
 * Run resumed event
 */
export const RunResumedEventSchema = BaseEventSchema.extend({
  type: z.literal('run.resumed'),
  payload: RunResumedPayloadSchema,
});

export type RunResumedEvent = z.infer<typeof RunResumedEventSchema>;

/**
 * Run suspended event
 */
export const RunSuspendedEventSchema = BaseEventSchema.extend({
  type: z.literal('run.suspended'),
  payload: RunSuspendedPayloadSchema,
});

export type RunSuspendedEvent = z.infer<typeof RunSuspendedEventSchema>;

/**
 * Tool called event
 */
export const ToolCalledEventSchema = BaseEventSchema.extend({
  type: z.literal('tool.called'),
  payload: ToolCalledPayloadSchema,
});

export type ToolCalledEvent = z.infer<typeof ToolCalledEventSchema>;

/**
 * Tool hint event
 */
export const ToolHintEventSchema = BaseEventSchema.extend({
  type: z.literal('tool.hint'),
  payload: ToolHintPayloadSchema,
});

export type ToolHintEvent = z.infer<typeof ToolHintEventSchema>;

/**
 * Tool result event
 */
export const ToolResultEventSchema = BaseEventSchema.extend({
  type: z.literal('tool.result'),
  payload: ToolResultPayloadSchema,
});

export type ToolResultEvent = z.infer<typeof ToolResultEventSchema>;

/**
 * Tool blocked event
 */
export const ToolBlockedEventSchema = BaseEventSchema.extend({
  type: z.literal('tool.blocked'),
  payload: ToolBlockedPayloadSchema,
});

export type ToolBlockedEvent = z.infer<typeof ToolBlockedEventSchema>;

/**
 * Tool requires approval event
 */
export const ToolRequiresApprovalEventSchema = BaseEventSchema.extend({
  type: z.literal('tool.requires_approval'),
  payload: ToolRequiresApprovalPayloadSchema,
});

export type ToolRequiresApprovalEvent = z.infer<typeof ToolRequiresApprovalEventSchema>;

/**
 * Tool approved event
 */
export const ToolApprovedEventSchema = BaseEventSchema.extend({
  type: z.literal('tool.approved'),
  payload: ToolApprovedPayloadSchema,
});

export type ToolApprovedEvent = z.infer<typeof ToolApprovedEventSchema>;

/**
 * Tool rejected event
 */
export const ToolRejectedEventSchema = BaseEventSchema.extend({
  type: z.literal('tool.rejected'),
  payload: ToolRejectedPayloadSchema,
});

export type ToolRejectedEvent = z.infer<typeof ToolRejectedEventSchema>;

/**
 * Step started event
 */
export const StepStartedEventSchema = BaseEventSchema.extend({
  type: z.literal('step.started'),
  payload: StepStartedPayloadSchema,
});

export type StepStartedEvent = z.infer<typeof StepStartedEventSchema>;

/**
 * Step completed event
 */
export const StepCompletedEventSchema = BaseEventSchema.extend({
  type: z.literal('step.completed'),
  payload: StepCompletedPayloadSchema,
});

export type StepCompletedEvent = z.infer<typeof StepCompletedEventSchema>;

/**
 * Step retried event
 */
export const StepRetriedEventSchema = BaseEventSchema.extend({
  type: z.literal('step.retried'),
  payload: StepRetriedPayloadSchema,
});

export type StepRetriedEvent = z.infer<typeof StepRetriedEventSchema>;

/**
 * LLM called event
 */
export const LLMCalledEventSchema = BaseEventSchema.extend({
  type: z.literal('llm.called'),
  payload: LLMCalledPayloadSchema,
});

export type LLMCalledEvent = z.infer<typeof LLMCalledEventSchema>;

/**
 * LLM token streaming event
 */
export const LLMTokenEventSchema = BaseEventSchema.extend({
  type: z.literal('llm.token'),
  payload: LLMTokenPayloadSchema,
});

export type LLMTokenEvent = z.infer<typeof LLMTokenEventSchema>;

// ─── Structured Message Events (Multi-role Orchestration) ────

export const MessageTaskEventSchema = BaseEventSchema.extend({
  type: z.literal('message.task'),
  payload: TaskMessagePayloadSchema,
});

export type MessageTaskEvent = z.infer<typeof MessageTaskEventSchema>;

export const MessageProposalEventSchema = BaseEventSchema.extend({
  type: z.literal('message.proposal'),
  payload: ProposalMessagePayloadSchema,
});

export type MessageProposalEvent = z.infer<typeof MessageProposalEventSchema>;

export const MessageDecisionEventSchema = BaseEventSchema.extend({
  type: z.literal('message.decision'),
  payload: DecisionMessagePayloadSchema,
});

export type MessageDecisionEvent = z.infer<typeof MessageDecisionEventSchema>;

export const MessageEvidenceEventSchema = BaseEventSchema.extend({
  type: z.literal('message.evidence'),
  payload: EvidenceMessagePayloadSchema,
});

export type MessageEvidenceEvent = z.infer<typeof MessageEvidenceEventSchema>;

export const MessageStatusEventSchema = BaseEventSchema.extend({
  type: z.literal('message.status'),
  payload: StatusMessagePayloadSchema,
});

export type MessageStatusEvent = z.infer<typeof MessageStatusEventSchema>;

// ─── New P0 Events ───────────────────────────────────────────

export const ToolBatchStartedEventSchema = BaseEventSchema.extend({
  type: z.literal('tool.batch.started'),
  payload: ToolBatchStartedPayloadSchema,
});

export type ToolBatchStartedEvent = z.infer<typeof ToolBatchStartedEventSchema>;

export const ToolBatchCompletedEventSchema = BaseEventSchema.extend({
  type: z.literal('tool.batch.completed'),
  payload: ToolBatchCompletedPayloadSchema,
});

export type ToolBatchCompletedEvent = z.infer<typeof ToolBatchCompletedEventSchema>;

export const RunCompactedEventSchema = BaseEventSchema.extend({
  type: z.literal('run.compacted'),
  payload: RunCompactedPayloadSchema,
});

export type RunCompactedEvent = z.infer<typeof RunCompactedEventSchema>;

export const RunWarningEventSchema = BaseEventSchema.extend({
  type: z.literal('run.warning'),
  payload: RunWarningPayloadSchema,
});

export type RunWarningEvent = z.infer<typeof RunWarningEventSchema>;

export const McpToolsRefreshedEventSchema = BaseEventSchema.extend({
  type: z.literal('mcp.tools.refreshed'),
  payload: McpToolsRefreshedPayloadSchema,
});

export type McpToolsRefreshedEvent = z.infer<typeof McpToolsRefreshedEventSchema>;

/**
 * Union of all event schemas
 */
export const EventSchema = z.discriminatedUnion('type', [
  RunStartedEventSchema,
  RunCompletedEventSchema,
  RunFailedEventSchema,
  RunResumedEventSchema,
  RunSuspendedEventSchema,
  RunCompactedEventSchema,
  RunWarningEventSchema,
  ToolHintEventSchema,
  ToolCalledEventSchema,
  ToolResultEventSchema,
  ToolBlockedEventSchema,
  ToolRequiresApprovalEventSchema,
  ToolApprovedEventSchema,
  ToolRejectedEventSchema,
  ToolBatchStartedEventSchema,
  ToolBatchCompletedEventSchema,
  StepStartedEventSchema,
  StepCompletedEventSchema,
  StepRetriedEventSchema,
  LLMCalledEventSchema,
  LLMTokenEventSchema,
  McpToolsRefreshedEventSchema,
  MessageTaskEventSchema,
  MessageProposalEventSchema,
  MessageDecisionEventSchema,
  MessageEvidenceEventSchema,
  MessageStatusEventSchema,
]);

export type Event = z.infer<typeof EventSchema>;
