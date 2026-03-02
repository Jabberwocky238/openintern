/**
 * Web UI Types - mirrors backend types for frontend use
 */

// Run status
export type RunStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'suspended'
  | 'completed'
  | 'failed'
  | 'cancelled';

// Run metadata
export interface RunMeta {
  run_id: string;
  session_key: string;
  status: RunStatus;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  event_count: number;
  tool_call_count: number;
  parent_run_id?: string | null;
}

// Event types
export type EventType =
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'run.resumed'
  | 'run.suspended'
  | 'step.started'
  | 'step.completed'
  | 'step.retried'
  | 'llm.called'
  | 'llm.token'
  | 'tool.hint'
  | 'tool.called'
  | 'tool.result'
  | 'tool.blocked'
  | 'tool.requires_approval'
  | 'tool.approved'
  | 'tool.rejected'
  | 'tool.batch.started'
  | 'tool.batch.completed'
  | 'message.task'
  | 'message.proposal'
  | 'message.decision'
  | 'message.evidence'
  | 'message.status';

// Base event structure
export interface BaseEvent {
  v: 1;
  ts: string;
  session_key: string;
  run_id: string;
  agent_id: string;
  step_id: string;
  span_id: string;
  parent_span_id: string | null;
  redaction: {
    contains_secrets: boolean;
  };
}

// Event payloads
export interface RunStartedPayload {
  input: string;
  config?: Record<string, unknown>;
}

export interface RunCompletedPayload {
  output: string;
  duration_ms: number;
}

export interface RunFailedPayload {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface RunSuspendedPayload {
  toolCallId: string;
  toolName: string;
  reason: string;
}

export interface RunResumedPayload {
  checkpoint_step_id: string;
  orphaned_tool_calls: number;
}

export interface ToolCalledPayload {
  toolName: string;
  args: Record<string, unknown>;
  tool_call_id?: string;
  human_intervened?: boolean;
  modified_args_applied?: boolean;
  effective_args?: Record<string, unknown>;
}

export interface ToolHintPayload {
  hint: string;
  tools: string[];
  tool_count: number;
}

export interface ToolResultPayload {
  toolName: string;
  result: unknown;
  isError: boolean;
  error?: {
    code: string;
    message: string;
  };
}

export interface ToolBlockedPayload {
  toolName: string;
  args: Record<string, unknown>;
  reason: string;
  role_id?: string;
  risk_level?: string;
}

export interface ToolRequiresApprovalPayload {
  toolName: string;
  tool_call_id: string;
  args: Record<string, unknown>;
  reason: string;
  risk_level?: string;
}

export interface ToolApprovedPayload {
  toolName: string;
  tool_call_id: string;
  modified_args?: Record<string, unknown>;
  modified_args_applied?: boolean;
}

export interface ToolRejectedPayload {
  toolName: string;
  tool_call_id: string;
  reason?: string;
}

export interface StepStartedPayload {
  stepNumber: number;
}

export interface StepCompletedPayload {
  stepNumber: number;
  resultType: 'tool_call' | 'final_answer' | 'continue';
  duration_ms: number;
}

export interface LLMCalledPayload {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  duration_ms: number;
}

export interface LLMTokenPayload {
  token: string;
  tokenIndex: number;
}

export interface MessageTaskPayload {
  goal?: string;
  inputs?: Record<string, unknown>;
  expected_output?: string;
  constraints?: string[];
  priority?: 'low' | 'medium' | 'high' | 'critical';
}

export interface MessageProposalPayload {
  plan?: string;
  risks?: string[];
  dependencies?: string[];
  evidence_refs?: Array<{ type: string; id: string }>;
}

export interface MessageDecisionPayload {
  decision?: string;
  rationale?: string;
  next_actions?: string[];
  evidence_refs?: Array<{ type: string; id: string }>;
}

export interface MessageEvidencePayload {
  refs?: Array<{ type: string; id: string }>;
  summary?: string;
}

export interface MessageStatusPayload {
  state?: 'working' | 'blocked' | 'done' | 'error';
  progress?: number;
  blockers?: string[];
}

// Blackboard memory types
export type MemoryType = 'core' | 'episodic' | 'archival';
export type EpisodicType = 'DECISION' | 'EVIDENCE' | 'TODO';

export interface BlackboardMemory {
  id: string;
  type: MemoryType;
  text: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  group_id: string;
}

// Orchestrator entities
export interface Group {
  id: string;
  name: string;
  description: string;
  project_id: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface Role {
  id: string;
  name: string;
  description: string;
  system_prompt: string;
  allowed_tools?: string[];
  denied_tools?: string[];
  style_constraints?: Record<string, unknown>;
  is_lead: boolean;
  created_at?: string;
  updated_at?: string;
}

export type SkillRiskLevel = 'low' | 'medium' | 'high';
export type SkillProvider = 'builtin' | 'mcp';

export interface SkillToolEntry {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  tools: SkillToolEntry[];
  risk_level: SkillRiskLevel;
  provider: SkillProvider;
  health_status: 'healthy' | 'unhealthy' | 'unknown';
  created_at?: string;
  updated_at?: string;
}

export interface GroupMember {
  id: string;
  group_id: string;
  role_id: string;
  agent_instance_id: string | null;
  ordinal: number;
  created_at?: string;
}

export interface GroupRunSummary {
  run_id: string;
  group_id: string;
  status: RunStatus;
  created_at: string;
}

// Re-export attachment type from events
export type { ChatMessageAttachment } from './events';
