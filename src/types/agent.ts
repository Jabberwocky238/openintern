import { z } from 'zod';

/**
 * Agent status schema
 */
export const AgentStatusSchema = z.object({
  status: z.enum(['idle', 'running', 'completed', 'failed']),
  currentStep: z.number().nonnegative(),
  maxSteps: z.number().positive(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  error: z.string().optional(),
});

export type AgentStatus = z.infer<typeof AgentStatusSchema>;

/**
 * Tool call schema
 */
export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  parameters: z.record(z.unknown()),
});

export type ToolCall = z.infer<typeof ToolCallSchema>;

/**
 * Step result schema
 */
export const StepResultSchema = z.object({
  stepId: z.string(),
  type: z.enum(['tool_call', 'final_answer', 'continue']),
  content: z.string(),
  toolCalls: z.array(ToolCallSchema).optional(),
});

export type StepResult = z.infer<typeof StepResultSchema>;

/**
 * Message role schema
 */
export const MessageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);

export type MessageRole = z.infer<typeof MessageRoleSchema>;

/**
 * Content part types for multimodal messages
 */
export const TextContentPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

export const ImageContentPartSchema = z.object({
  type: z.literal('image'),
  image: z.object({
    data: z.string(),
    mimeType: z.string(),
  }),
});

export const ContentPartSchema = z.discriminatedUnion('type', [
  TextContentPartSchema,
  ImageContentPartSchema,
]);

export type TextContentPart = z.infer<typeof TextContentPartSchema>;
export type ImageContentPart = z.infer<typeof ImageContentPartSchema>;
export type ContentPart = z.infer<typeof ContentPartSchema>;

/**
 * Message schema for LLM context
 */
export const MessageSchema = z.object({
  role: MessageRoleSchema,
  content: z.union([z.string(), z.array(ContentPartSchema)]),
  toolCallId: z.string().optional(),
  name: z.string().optional(),
  toolCalls: z.array(ToolCallSchema).optional(),
});

export type Message = z.infer<typeof MessageSchema>;

/**
 * Extract text content from a message's content field.
 * Works for both string content and ContentPart[] content.
 */
export function getMessageText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is TextContentPart => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/**
 * Tool definition schema
 */
export const ToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.unknown()),
  /** Tool metadata for scheduling and policy decisions */
  metadata: z.object({
    risk_level: z.enum(['low', 'medium', 'high']).default('low'),
    mutating: z.boolean().default(false),
    supports_parallel: z.boolean().default(true),
    timeout_ms: z.number().positive().optional(),
  }).optional(),
});

export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

/**
 * Tool batch call - a group of tool calls to be executed together
 */
export const ToolBatchCallSchema = z.object({
  batch_id: z.string(),
  calls: z.array(ToolCallSchema),
  strategy: z.enum(['parallel', 'serial']),
});

export type ToolBatchCall = z.infer<typeof ToolBatchCallSchema>;

/**
 * Tool policy decision - three-state result
 */
export const ToolPolicyDecisionSchema = z.object({
  decision: z.enum(['allow', 'deny', 'ask']),
  reason: z.string(),
  tool_name: z.string(),
});

export type ToolPolicyDecision = z.infer<typeof ToolPolicyDecisionSchema>;

/**
 * Budget state for context tracking
 */
export const BudgetStateSchema = z.object({
  total_tokens_used: z.number().nonnegative(),
  max_context_tokens: z.number().positive(),
  utilization: z.number().min(0).max(1),
  compaction_count: z.number().nonnegative(),
  last_compacted_at: z.string().datetime().optional(),
});

export type BudgetState = z.infer<typeof BudgetStateSchema>;

/**
 * Tool result schema
 */
export const ToolResultSchema = z.object({
  success: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  duration: z.number().nonnegative(),
  blocked: z.boolean().optional(),
  requiresApproval: z.boolean().optional(),
  requiresSuspension: z.boolean().optional(),
  policyReason: z.string().optional(),
  riskLevel: z.string().optional(),
  humanInterventionNote: z.string().optional(),
});

export type ToolResult = z.infer<typeof ToolResultSchema>;

/**
 * LLM response schema
 */
export const LLMResponseSchema = z.object({
  content: z.string(),
  toolCalls: z.array(ToolCallSchema).optional(),
  usage: z.object({
    promptTokens: z.number().nonnegative(),
    completionTokens: z.number().nonnegative(),
    totalTokens: z.number().nonnegative(),
  }),
});

export type LLMResponse = z.infer<typeof LLMResponseSchema>;

/**
 * LLM context schema
 */
export const LLMContextSchema = z.object({
  systemPrompt: z.string(),
  messages: z.array(MessageSchema),
  totalTokens: z.number().nonnegative(),
});

export type LLMContext = z.infer<typeof LLMContextSchema>;

/**
 * Retry policy configuration
 */
export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * Context manager configuration
 */
export interface ContextConfig {
  maxTokens: number;
  systemPrompt: string;
  includeMemory: boolean;
  maxMessages?: number;
  /** Working directory path to include in system prompt */
  workDir?: string;
  /** Model's maximum context window size in tokens */
  modelMaxTokens?: number;
  /** Minimum available tokens before blocking execution */
  minContextTokens?: number;
  /** Token threshold for warning about low context */
  warnContextTokens?: number;
  /** Number of recent conversation turns to always preserve */
  preserveTurns?: number;
}

/**
 * LLM client configuration
 */
export interface LLMConfig {
  provider: 'openai' | 'anthropic' | 'gemini' | 'mock';
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Top-level agent configuration (loaded from agent.config.ts/js/json)
 */
export interface AgentConfig {
  llm?: {
    provider?: 'openai' | 'anthropic' | 'gemini' | 'mock';
    model?: string;
    apiKey?: string;
    baseUrl?: string;
    temperature?: number;
    maxTokens?: number;
  };
  planner?: {
    llm?: {
      provider?: 'openai' | 'anthropic' | 'gemini' | 'mock';
      model?: string;
      apiKey?: string;
      baseUrl?: string;
      temperature?: number;
      maxTokens?: number;
    };
  };
  server?: {
    port?: number;
    baseDir?: string;
    corsOrigins?: string | string[];
    databaseUrl?: string;
  };
  agent?: {
    maxSteps?: number;
    timeout?: number;
    persistLlmTokens?: boolean;
    /** Working directory for file tools (absolute path) */
    workDir?: string;
  };
  embedding?: {
    provider?: 'hash' | 'api';
    dimension?: number;
    alpha?: number;
    apiUrl?: string;
    apiModel?: string;
  };
  feishu?: {
    enabled?: boolean;
    appId?: string;
    appSecret?: string;
    baseUrl?: string;
    timeoutMs?: number;
    maxRetries?: number;
    pollIntervalMs?: number;
    im?: {
      enabled?: boolean;
      verifyToken?: string;
      defaultOrgId?: string;
      defaultUserId?: string;
      defaultProjectId?: string;
      agentId?: string;
      sessionPrefix?: string;
      waitTimeoutMs?: number;
      pollIntervalMs?: number;
    };
  };
  mineru?: {
    enabled?: boolean;
    mode?: 'v4';
    apiKey?: string;
    baseUrl?: string;
    uidToken?: string;
    timeoutMs?: number;
    maxRetries?: number;
    pollIntervalMs?: number;
    maxPollAttempts?: number;
    defaultModelVersion?: 'pipeline' | 'vlm' | 'MinerU-HTML';
  };
  sandbox?: {
    enabled?: boolean;
    jailDir?: string;
    fileTypeBlacklist?: string[];
    fileTypeWhitelist?: string[];
    maxWriteSize?: number;
    rateLimit?: {
      maxCalls?: number;
      windowMs?: number;
    };
  };
}
