import type { ToolCall, ToolResult } from '../../types/agent.js';
import type { Event, EventType } from '../../types/events.js';
import type { RuntimeToolRouter } from './tool-router.js';
import type { AgentContext } from './tool-policy.js';
import { generateSpanId } from '../../utils/ids.js';
import { logger } from '../../utils/logger.js';
import { buildHumanOverrideNote, hasHumanModifiedArgs } from './hitl-note.js';
import { summarizeToolResultForEvent } from './tool-result-content.js';

/**
 * Tool metadata used for scheduling decisions.
 */
export interface ToolScheduleMeta {
  mutating: boolean;
  supports_parallel: boolean;
  risk_level: 'low' | 'medium' | 'high';
  timeout_ms?: number;
}

/**
 * Result of a single tool execution within a batch.
 */
export interface ToolExecResult {
  toolCall: ToolCall;
  result: ToolResult;
}

/**
 * Result of executing a full batch of tool calls.
 */
export interface BatchResult {
  batch_id: string;
  results: ToolExecResult[];
  events: Event[];
  duration_ms: number;
  /** Set when a tool requires approval and the run was suspended */
  suspended?: {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    reason: string;
  };
}

/**
 * Pending approval state for a tool call awaiting human decision.
 */
export interface PendingApproval {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  riskLevel: string;
  reason: string;
  runId: string;
  resolve: (decision: ApprovalDecision) => void;
}

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
  modifiedArgs?: Record<string, unknown>;
}

export interface SuspendedApprovalRequest {
  runId: string;
  sessionKey: string;
  agentId: string;
  toolCallId: string;
  modifiedArgs?: Record<string, unknown>;
  scope: { orgId: string; userId: string; projectId: string | null };
}

export interface SuspendedApprovalResult {
  toolName: string;
  effectiveArgs: Record<string, unknown>;
  modifiedArgsApplied: boolean;
}

type SuspendedApprovalExecutor = (
  request: SuspendedApprovalRequest
) => Promise<SuspendedApprovalResult>;

/**
 * Thrown when a tool requires approval and the run should suspend to disk.
 */
export class RunSuspendedError extends Error {
  constructor(
    public readonly toolCallId: string,
    public readonly toolName: string,
    public readonly args: Record<string, unknown>,
    public readonly reason: string
  ) {
    super(`Run suspended: tool ${toolName} requires approval`);
    this.name = 'RunSuspendedError';
  }
}

/** Default concurrency limit for parallel tool execution. */
const DEFAULT_PARALLEL_LIMIT = 8;

/**
 * ToolApprovalManager manages pending tool approvals using Promise + resolver pattern.
 * When a tool requires approval, a Promise is created and its resolver stored.
 * The approve/reject API endpoints resolve the Promise to resume execution.
 */
export class ToolApprovalManager {
  private readonly pending = new Map<string, PendingApproval>();
  private suspendedApprovalExecutor: SuspendedApprovalExecutor | null = null;

  /**
   * Register a pending approval and return a Promise that resolves when
   * the user approves or rejects.
   */
  waitForApproval(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    riskLevel: string,
    reason: string,
    runId: string,
    abortSignal?: AbortSignal
  ): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      this.pending.set(toolCallId, {
        toolCallId,
        toolName,
        args,
        riskLevel,
        reason,
        runId,
        resolve,
      });
      abortSignal?.addEventListener('abort', () => {
        if (this.pending.has(toolCallId)) {
          this.pending.delete(toolCallId);
          resolve({ approved: false, reason: 'Run cancelled' });
        }
      }, { once: true });
    });
  }

  /**
   * Approve a pending tool call. Returns true if the approval was found and resolved.
   */
  approve(toolCallId: string, modifiedArgs?: Record<string, unknown>): boolean {
    const entry = this.pending.get(toolCallId);
    if (!entry) return false;
    entry.resolve({
      approved: true,
      ...(modifiedArgs ? { modifiedArgs } : {}),
    });
    this.pending.delete(toolCallId);
    return true;
  }

  /**
   * Reject a pending tool call. Returns true if the rejection was found and resolved.
   */
  reject(toolCallId: string, reason?: string): boolean {
    const entry = this.pending.get(toolCallId);
    if (!entry) return false;
    entry.resolve({ approved: false, ...(reason !== undefined ? { reason } : {}) });
    this.pending.delete(toolCallId);
    return true;
  }

  /**
   * Get a pending approval by tool call ID.
   */
  getPending(toolCallId: string): PendingApproval | undefined {
    return this.pending.get(toolCallId);
  }

  /**
   * Get all pending approvals for a given run.
   */
  getPendingForRun(runId: string): PendingApproval[] {
    return [...this.pending.values()].filter((p) => p.runId === runId);
  }

  /**
   * Check if there are any pending approvals for a run.
   */
  hasPendingForRun(runId: string): boolean {
    for (const entry of this.pending.values()) {
      if (entry.runId === runId) return true;
    }
    return false;
  }

  /**
   * Cancel all pending approvals for a run (e.g. when run is cancelled).
   */
  cancelForRun(runId: string): void {
    for (const [id, entry] of this.pending.entries()) {
      if (entry.runId === runId) {
        entry.resolve({ approved: false, reason: 'Run cancelled' });
        this.pending.delete(id);
      }
    }
  }

  setSuspendedApprovalExecutor(executor: SuspendedApprovalExecutor): void {
    this.suspendedApprovalExecutor = executor;
  }

  async approveSuspended(request: SuspendedApprovalRequest): Promise<SuspendedApprovalResult> {
    if (!this.suspendedApprovalExecutor) {
      throw new Error('Suspended approval executor not configured');
    }
    return this.suspendedApprovalExecutor(request);
  }
}

/**
 * ToolCallScheduler partitions tool calls by safety (mutating vs read-only)
 * and executes them in parallel or serial groups accordingly.
 *
 * Strategy:
 * - read/inspect tools (mutating=false, risk!=high) -> parallel group
 * - write/exec tools (mutating=true or risk=high) -> serial group
 * - Serial group always runs after parallel group completes
 */
export class ToolCallScheduler {
  private readonly parallelLimit: number;
  readonly approvalManager: ToolApprovalManager;

  constructor(opts?: { parallelLimit?: number; approvalManager?: ToolApprovalManager }) {
    this.parallelLimit = opts?.parallelLimit ?? DEFAULT_PARALLEL_LIMIT;
    this.approvalManager = opts?.approvalManager ?? new ToolApprovalManager();
  }

  /**
   * Execute a batch of tool calls with automatic parallel/serial partitioning.
   */
  async executeBatch(
    calls: ToolCall[],
    router: RuntimeToolRouter,
    ctx: {
      runId: string;
      sessionKey: string;
      agentId: string;
      stepId: string;
      rootSpan: string;
      agentContext?: AgentContext;
      abortSignal?: AbortSignal;
      /** Callback to emit events during execution (for approval flow). */
      onEvent?: (event: Event) => void;
      /** Callback to transition run to waiting status (legacy in-memory). */
      onWaiting?: () => Promise<void>;
      /** Callback to resume run from waiting status (legacy in-memory). */
      onResumed?: () => Promise<void>;
      /** Callback to suspend run to disk (new checkpoint-based). */
      onSuspend?: (reason: string) => Promise<void>;
    }
  ): Promise<BatchResult> {
    const batchId = `batch_${generateSpanId()}`;
    const started = Date.now();
    const events: Event[] = [];
    const allResults: ToolExecResult[] = [];

    const { parallel, serial } = this.partitionCallsBySafety(calls, router);

    // Emit batch started
    events.push(this.createBatchEvent(ctx, 'tool.batch.started', {
      batch_id: batchId,
      tool_count: calls.length,
      strategy: parallel.length > 0 && serial.length > 0 ? 'parallel' : 'serial',
    }));

    // Execute parallel group first
    if (parallel.length > 0) {
      const pResults = await this.executeParallelGroup(
        parallel, router, ctx
      );
      allResults.push(...pResults.results);
      events.push(...pResults.events);
    }

    // Then execute serial group
    if (serial.length > 0) {
      const sResults = await this.executeSerialGroup(
        serial, router, ctx
      );
      allResults.push(...sResults.results);
      events.push(...sResults.events);
    }

    const duration_ms = Date.now() - started;
    const successCount = allResults.filter((r) => r.result.success).length;

    events.push(this.createBatchEvent(ctx, 'tool.batch.completed', {
      batch_id: batchId,
      tool_count: calls.length,
      success_count: successCount,
      failure_count: calls.length - successCount,
      duration_ms,
    }));

    return { batch_id: batchId, results: allResults, events, duration_ms };
  }

  /**
   * Partition tool calls into parallel-safe and serial-only groups.
   */
  partitionCallsBySafety(
    calls: ToolCall[],
    router: RuntimeToolRouter
  ): { parallel: ToolCall[]; serial: ToolCall[] } {
    const parallel: ToolCall[] = [];
    const serial: ToolCall[] = [];

    for (const call of calls) {
      const meta = this.getToolMeta(call.name, router);
      if (!meta.mutating && meta.supports_parallel && meta.risk_level !== 'high') {
        parallel.push(call);
      } else {
        serial.push(call);
      }
    }

    return { parallel, serial };
  }

  private async executeParallelGroup(
    calls: ToolCall[],
    router: RuntimeToolRouter,
    ctx: {
      stepId: string;
      rootSpan: string;
      runId: string;
      sessionKey: string;
      agentId: string;
      agentContext?: AgentContext;
      abortSignal?: AbortSignal;
      onEvent?: (event: Event) => void;
      onWaiting?: () => Promise<void>;
      onResumed?: () => Promise<void>;
      onSuspend?: (reason: string) => Promise<void>;
    }
  ): Promise<{ results: ToolExecResult[]; events: Event[] }> {
    const events: Event[] = [];
    const results: ToolExecResult[] = [];

    // Execute in chunks respecting parallelLimit
    for (let i = 0; i < calls.length; i += this.parallelLimit) {
      if (ctx.abortSignal?.aborted) break;

      const chunk = calls.slice(i, i + this.parallelLimit);
      const promises = chunk.map(async (call) => {
        events.push(this.createToolEvent(ctx, 'tool.called', {
          toolName: call.name,
          args: call.parameters,
        }));

        const result = await this.executeWithApproval(call, router, ctx, events);
        events.push(this.createToolResultEvent(ctx, call.name, result));
        return { toolCall: call, result };
      });

      const chunkResults = await Promise.allSettled(promises);
      for (const settled of chunkResults) {
        if (settled.status === 'fulfilled') {
          results.push(settled.value);
        } else {
          logger.error('Parallel tool execution failed', {
            error: settled.reason,
          });
        }
      }
    }

    return { results, events };
  }

  private async executeSerialGroup(
    calls: ToolCall[],
    router: RuntimeToolRouter,
    ctx: {
      stepId: string;
      rootSpan: string;
      runId: string;
      sessionKey: string;
      agentId: string;
      agentContext?: AgentContext;
      abortSignal?: AbortSignal;
      onEvent?: (event: Event) => void;
      onWaiting?: () => Promise<void>;
      onResumed?: () => Promise<void>;
      onSuspend?: (reason: string) => Promise<void>;
    }
  ): Promise<{ results: ToolExecResult[]; events: Event[] }> {
    const events: Event[] = [];
    const results: ToolExecResult[] = [];

    for (const call of calls) {
      if (ctx.abortSignal?.aborted) break;

      events.push(this.createToolEvent(ctx, 'tool.called', {
        toolName: call.name,
        args: call.parameters,
      }));

      const result = await this.executeWithApproval(call, router, ctx, events);
      events.push(this.createToolResultEvent(ctx, call.name, result));
      results.push({ toolCall: call, result });
    }

    return { results, events };
  }

  /**
   * Execute a tool call, handling the approval flow if the tool requires it.
   * When a tool returns requiresApproval=true:
   * 1. Emit tool.requires_approval event
   * 2. Transition run to waiting status
   * 3. Wait for user approval/rejection via Promise
   * 4. On approve: execute the tool and return result
   * 5. On reject: return error result
   */
  private async executeWithApproval(
    call: ToolCall,
    router: RuntimeToolRouter,
    ctx: {
      stepId: string;
      rootSpan: string;
      runId: string;
      sessionKey: string;
      agentId: string;
      agentContext?: AgentContext;
      abortSignal?: AbortSignal;
      onEvent?: (event: Event) => void;
      onWaiting?: () => Promise<void>;
      onResumed?: () => Promise<void>;
      onSuspend?: (reason: string) => Promise<void>;
    },
    events: Event[]
  ): Promise<ToolResult> {
    const approvalStarted = Date.now();
    const paramsWithInternalCallId = this.withInternalToolCallId(
      call.name,
      call.id,
      call.parameters
    );
    const result = await router.callTool(
      call.name, paramsWithInternalCallId, ctx.agentContext
    );

    // If tool requires suspension (e.g. routing/escalation), suspend immediately
    if (result.requiresSuspension && ctx.onSuspend) {
      const reason = 'Delegated to child runs';
      await ctx.onSuspend(reason);
      throw new RunSuspendedError(call.id, call.name, call.parameters, reason);
    }

    // If tool doesn't require approval, return as-is
    if (!result.requiresApproval) {
      return result;
    }

    const reason = result.policyReason ?? 'Tool requires human approval';

    // Emit tool.requires_approval event
    const approvalEvent = this.createApprovalEvent(ctx, {
      toolName: call.name,
      tool_call_id: call.id,
      args: call.parameters,
      reason,
      risk_level: result.riskLevel ?? 'high',
    });
    events.push(approvalEvent);
    ctx.onEvent?.(approvalEvent);

    // New path: suspend to disk instead of holding a Promise in memory
    if (ctx.onSuspend) {
      await ctx.onSuspend(reason);
      throw new RunSuspendedError(call.id, call.name, call.parameters, reason);
    }

    // Legacy path: hold Promise in memory
    const decisionPromise = this.approvalManager.waitForApproval(
      call.id, call.name, call.parameters,
      result.riskLevel ?? 'high', reason, ctx.runId, ctx.abortSignal
    );

    await ctx.onWaiting?.();

    logger.info('Tool call waiting for approval', {
      runId: ctx.runId, toolName: call.name, toolCallId: call.id,
    });

    const decision = await decisionPromise;
    await ctx.onResumed?.();

    if (decision.approved) {
      const effectiveArgs = decision.modifiedArgs ?? call.parameters;
      const modifiedArgsApplied = hasHumanModifiedArgs(call.parameters, decision.modifiedArgs);
      const validation = router.validateToolArgs(call.name, effectiveArgs);

      if (modifiedArgsApplied) {
        const modifiedCalled = this.createToolEvent(ctx, 'tool.called', {
          toolName: call.name,
          args: effectiveArgs,
          tool_call_id: call.id,
          human_intervened: true,
          modified_args_applied: true,
          effective_args: effectiveArgs,
        });
        events.push(modifiedCalled);
        ctx.onEvent?.(modifiedCalled);
      }

      const approvedEvent = this.createGenericEvent(ctx, 'tool.approved', {
        toolName: call.name,
        tool_call_id: call.id,
        modified_args_applied: modifiedArgsApplied,
        ...(decision.modifiedArgs ? { modified_args: decision.modifiedArgs } : {}),
      });
      events.push(approvedEvent);
      ctx.onEvent?.(approvedEvent);

      if (!validation.ok) {
        return {
          success: false,
          error: `Invalid tool arguments: ${validation.message}`,
          duration: Date.now() - approvalStarted,
          ...(modifiedArgsApplied
            ? { humanInterventionNote: buildHumanOverrideNote(effectiveArgs) }
            : {}),
        };
      }

      const approvedParams = this.withInternalToolCallId(
        call.name,
        call.id,
        effectiveArgs
      );
      const approvedResult = await router.callTool(call.name, approvedParams);
      if (!modifiedArgsApplied) {
        return approvedResult;
      }
      return {
        ...approvedResult,
        humanInterventionNote: buildHumanOverrideNote(effectiveArgs),
      };
    }

    const rejectedEvent = this.createGenericEvent(ctx, 'tool.rejected', {
      toolName: call.name, tool_call_id: call.id,
      ...(decision.reason ? { reason: decision.reason } : {}),
    });
    events.push(rejectedEvent);
    ctx.onEvent?.(rejectedEvent);

    return {
      success: false,
      error: `Tool call rejected by user${decision.reason ? `: ${decision.reason}` : ''}`,
      duration: Date.now() - approvalStarted,
    };
  }

  private withInternalToolCallId(
    toolName: string,
    toolCallId: string,
    args: Record<string, unknown>
  ): Record<string, unknown> {
    if (toolName !== 'handoff_to' && toolName !== 'dispatch_subtasks') {
      return args;
    }
    if ('__tool_call_id' in args) {
      return args;
    }
    return { ...args, __tool_call_id: toolCallId };
  }

  private getToolMeta(toolName: string, router: RuntimeToolRouter): ToolScheduleMeta {
    const tools = router.listTools();
    const def = tools.find((t) => t.name === toolName);
    if (def?.metadata) {
      return {
        mutating: def.metadata.mutating ?? false,
        supports_parallel: def.metadata.supports_parallel ?? true,
        risk_level: def.metadata.risk_level ?? 'low',
        ...(def.metadata.timeout_ms !== undefined
          ? { timeout_ms: def.metadata.timeout_ms }
          : {}),
      };
    }
    // Default: read-only tools are safe for parallel
    const isWrite = /^(write_|exec_|apply_|memory_write)/.test(toolName);
    return {
      mutating: isWrite,
      supports_parallel: !isWrite,
      risk_level: 'low',
    };
  }

  private createBatchEvent(
    ctx: { runId: string; sessionKey: string; agentId: string; stepId: string; rootSpan: string },
    type: 'tool.batch.started' | 'tool.batch.completed',
    payload: Record<string, unknown>
  ): Event {
    return {
      v: 1,
      ts: new Date().toISOString(),
      session_key: ctx.sessionKey,
      run_id: ctx.runId,
      agent_id: ctx.agentId,
      step_id: ctx.stepId,
      span_id: generateSpanId(),
      parent_span_id: ctx.rootSpan,
      redaction: { contains_secrets: false },
      type,
      payload,
    } as Event;
  }

  private createToolEvent(
    ctx: { runId: string; sessionKey: string; agentId: string; stepId: string; rootSpan: string },
    type: 'tool.called',
    payload: {
      toolName: string;
      args: Record<string, unknown>;
      tool_call_id?: string;
      human_intervened?: boolean;
      modified_args_applied?: boolean;
      effective_args?: Record<string, unknown>;
    }
  ): Event {
    return {
      v: 1,
      ts: new Date().toISOString(),
      session_key: ctx.sessionKey,
      run_id: ctx.runId,
      agent_id: ctx.agentId,
      step_id: ctx.stepId,
      span_id: generateSpanId(),
      parent_span_id: ctx.rootSpan,
      redaction: { contains_secrets: false },
      type,
      payload,
    } as Event;
  }

  private createApprovalEvent(
    ctx: { runId: string; sessionKey: string; agentId: string; stepId: string; rootSpan: string },
    payload: { toolName: string; tool_call_id: string; args: Record<string, unknown>; reason: string; risk_level?: string }
  ): Event {
    return {
      v: 1,
      ts: new Date().toISOString(),
      session_key: ctx.sessionKey,
      run_id: ctx.runId,
      agent_id: ctx.agentId,
      step_id: ctx.stepId,
      span_id: generateSpanId(),
      parent_span_id: ctx.rootSpan,
      redaction: { contains_secrets: false },
      type: 'tool.requires_approval',
      payload,
    } as Event;
  }

  private createGenericEvent(
    ctx: { runId: string; sessionKey: string; agentId: string; stepId: string; rootSpan: string },
    type: EventType,
    payload: Record<string, unknown>
  ): Event {
    return {
      v: 1,
      ts: new Date().toISOString(),
      session_key: ctx.sessionKey,
      run_id: ctx.runId,
      agent_id: ctx.agentId,
      step_id: ctx.stepId,
      span_id: generateSpanId(),
      parent_span_id: ctx.rootSpan,
      redaction: { contains_secrets: false },
      type,
      payload,
    } as Event;
  }

  private createToolResultEvent(
    ctx: { runId: string; sessionKey: string; agentId: string; stepId: string; rootSpan: string },
    toolName: string,
    result: ToolResult
  ): Event {
    return {
      v: 1,
      ts: new Date().toISOString(),
      session_key: ctx.sessionKey,
      run_id: ctx.runId,
      agent_id: ctx.agentId,
      step_id: ctx.stepId,
      span_id: generateSpanId(),
      parent_span_id: ctx.rootSpan,
      redaction: { contains_secrets: false },
      type: 'tool.result',
      payload: {
        toolName,
        result: summarizeToolResultForEvent(result),
        isError: !result.success,
        ...(result.success ? {} : {
          error: { code: 'TOOL_ERROR', message: result.error ?? 'Unknown error' },
        }),
      },
    } as Event;
  }
}
