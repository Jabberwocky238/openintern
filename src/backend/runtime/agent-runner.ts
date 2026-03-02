import type { LLMConfig, Message, ToolCall, ContentPart, LLMResponse } from '@openintern/types/agent.js';
import { getMessageText } from '@openintern/types/agent.js';
import type { Event, EventType } from '@openintern/types/events.js';
import type { ScopeContext } from './scope.js';
import { createLLMClient, type ILLMClient } from '../agent/llm-client.js';
import { TokenCounter } from '../agent/token-counter.js';
import { detectOrphanedToolCalls, generateSyntheticResults } from '../agent/orphan-detector.js';
import { generateSpanId, generateStepId } from '@openintern/utils';
import { logger } from '@openintern/utils';
import { CheckpointService } from './checkpoint-service.js';
import { CompactionService } from './compaction-service.js';
import { MemoryService } from './memory-service.js';
import { PromptComposer, type ComposeInput, type SkillInjection } from './prompt-composer.js';
import { RuntimeToolRouter } from './tool-router.js';
import { TokenBudgetManager } from './token-budget-manager.js';
import { ToolCallScheduler, RunSuspendedError } from './tool-scheduler.js';
import type { ToolResult } from '@openintern/types/agent.js';
import type { AgentContext } from './tool-policy.js';
import type { GroupWithRoles } from '@openintern/repository';
import { formatToolResultMessageContent, summarizeToolResultForEvent } from './tool-result-content.js';

export interface RunnerContext {
  runId: string;
  sessionKey: string;
  scope: ScopeContext;
  agentId: string;
  groupId?: string;
  agentInstanceId?: string;
  abortSignal?: AbortSignal;
  /** Prior conversation history from earlier runs in the same session */
  history?: Message[];
  /** Multipart input content (text + images/files) when attachments are present */
  inputContent?: ContentPart[];
  /** Callback to emit events immediately (for approval flow SSE broadcast) */
  onEvent?: (event: Event) => void;
  /** Callback to transition run to waiting status */
  onWaiting?: () => Promise<void>;
  /** Callback to resume run from waiting status */
  onResumed?: () => Promise<void>;
  /** Callback to suspend run to disk (checkpoint-based) */
  onSuspend?: (reason: string) => Promise<void>;
  /** Restored checkpoint state for resuming a suspended run */
  resumeFrom?: {
    stepNumber: number;
    messages: Message[];
    workingState: Record<string, unknown>;
  };
}

export interface RunnerResult {
  status: 'completed' | 'failed' | 'suspended';
  output?: string;
  error?: string;
  steps: number;
}

export interface AgentRunner {
  run(input: string, ctx: RunnerContext): AsyncGenerator<Event, RunnerResult, void>;
}

export interface SingleAgentRunnerConfig {
  maxSteps: number;
  modelConfig: LLMConfig;
  checkpointService: CheckpointService;
  memoryService: MemoryService;
  toolRouter: RuntimeToolRouter;
  /** Custom system prompt (overrides default) */
  systemPrompt?: string;
  /** Agent context for tool policy checks (multi-role mode) */
  agentContext?: AgentContext;
  /** Tool call scheduler for parallel/serial execution */
  toolScheduler?: ToolCallScheduler;
  /** Prompt composer for layered prompt building */
  promptComposer?: PromptComposer;
  /** Token budget manager for context tracking */
  budgetManager?: TokenBudgetManager;
  /** Compaction service for context compression */
  compactionService?: CompactionService;
  /** Skill content injections (loaded SKILL.md content) */
  skillInjections?: SkillInjection[];
  /** Available groups for escalation (injected into system prompt) */
  availableGroups?: GroupWithRoles[];
  /** Working directory for environment context */
  workDir?: string;
}

/** Max consecutive identical tool call signatures before doom-loop breaker fires */
const DOOM_LOOP_THRESHOLD = 3;
const LOOKUP_LOOP_STREAK_THRESHOLD = 3;
const LOOKUP_LOOP_STEPS_REMAINING_THRESHOLD = 2;
const LOOKUP_TOOL_NAMES = new Set<string>([
  'read_file',
  'grep_files',
  'glob_files',
  'list_files',
  'memory_search',
  'memory_get',
]);
const PREFLIGHT_COMPACTION_ATTEMPTS = 2;
const THINK_BLOCK_REGEX = /<think>[\s\S]*?<\/think>/gi;
const TOOL_HINT_VALUE_MAX_LEN = 40;

class RunCancelledError extends Error {
  constructor(message: string = 'Run cancelled by user') {
    super(message);
    this.name = 'RunCancelledError';
  }
}

export class SingleAgentRunner implements AgentRunner {
  private readonly maxSteps: number;
  private readonly toolScheduler: ToolCallScheduler;
  private readonly promptComposer: PromptComposer;
  private readonly budgetManager: TokenBudgetManager | null;
  private readonly compactionService: CompactionService | null;
  private readonly promptTokenCounter: TokenCounter;
  /** Tracks recent tool call signatures for doom-loop detection */
  private readonly recentToolSignatures: string[] = [];

  constructor(private readonly config: SingleAgentRunnerConfig) {
    this.maxSteps = config.maxSteps;
    this.toolScheduler = config.toolScheduler ?? new ToolCallScheduler();
    this.promptComposer = config.promptComposer ?? new PromptComposer({
      ...(config.systemPrompt != null && { basePrompt: config.systemPrompt }),
      ...(config.modelConfig.provider !== 'mock' && { provider: config.modelConfig.provider }),
    });
    this.budgetManager = config.budgetManager ?? null;
    this.compactionService = config.compactionService ?? null;
    this.promptTokenCounter = new TokenCounter();
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new RunCancelledError();
    }
  }

  private stripThinkBlocks(content: string): string {
    return content.replace(THINK_BLOCK_REGEX, '').trim();
  }

  private sanitizeFinalOutput(content: string): string {
    const stripped = this.stripThinkBlocks(content);
    if (stripped.length > 0) {
      return stripped;
    }
    const fallback = content.trim();
    return fallback.length > 0 ? fallback : 'I have completed processing but have no response to give.';
  }

  private buildMaxStepsOutput(): string {
    return (
      `I reached the maximum number of tool call iterations (${this.maxSteps}) ` +
      'without completing the task. You can try breaking the task into smaller steps.'
    );
  }

  private formatToolHint(toolCalls: ToolCall[]): string {
    const hints = toolCalls.map((toolCall) => {
      const firstArg = Object.values(toolCall.parameters ?? {}).find((value) => typeof value === 'string');
      if (typeof firstArg !== 'string') {
        return toolCall.name;
      }
      if (firstArg.length > TOOL_HINT_VALUE_MAX_LEN) {
        return `${toolCall.name}("${firstArg.slice(0, TOOL_HINT_VALUE_MAX_LEN)}...")`;
      }
      return `${toolCall.name}("${firstArg}")`;
    });
    return hints.join(', ');
  }

  async *run(input: string, ctx: RunnerContext): AsyncGenerator<Event, RunnerResult, void> {
    const resuming = ctx.resumeFrom != null;
    let messages: Message[];
    let lastSavedMessageCount: number;
    let startStep: number;
    let orphanedToolCallCount = 0;

    if (resuming) {
      const resumedMessages = [...ctx.resumeFrom!.messages];
      const orphaned = detectOrphanedToolCalls(resumedMessages);
      orphanedToolCallCount = orphaned.length;
      const syntheticResults = generateSyntheticResults(orphaned);
      messages = [...resumedMessages, ...syntheticResults];
      lastSavedMessageCount = resumedMessages.length;
      startStep = ctx.resumeFrom!.stepNumber + 1;
    } else {
      const userContent: string | ContentPart[] = ctx.inputContent ?? input;
      messages = [
        ...(ctx.history ?? []),
        { role: 'user', content: userContent },
      ];
      lastSavedMessageCount = 0;
      startStep = 1;
    }

    const llmClient = createLLMClient(this.config.modelConfig);
    const rootSpan = generateSpanId();
    const startedAt = Date.now();
    let lastToolResult: unknown = null;
    let lastMemoryHits: Array<{ id: string; snippet: string; score: number; type: string }> = [];
    let lookupOnlyToolStreak = 0;
    let steps = 0;

    if (resuming) {
      const checkpointStepId = generateStepId(ctx.resumeFrom!.stepNumber);
      yield this.createEvent(ctx, generateStepId(0), rootSpan, 'run.resumed', {
        checkpoint_step_id: checkpointStepId,
        orphaned_tool_calls: orphanedToolCallCount,
      });
    } else {
      yield this.createEvent(ctx, generateStepId(0), rootSpan, 'run.started' as EventType, { input });
    }

    try {
      for (let step = startStep; step <= this.maxSteps; step++) {
        this.throwIfAborted(ctx.abortSignal);
        steps = step;
        const stepId = generateStepId(step);
        const stepStart = Date.now();

        yield this.createEvent(ctx, stepId, rootSpan, 'step.started', {
          stepNumber: step,
        });

        // ── Context budget check & auto-compaction ──
        const compactionEvents = yield* this.maybeCompactContext(
          messages, ctx, stepId, rootSpan, step
        );
        if (compactionEvents.compacted) {
          messages = compactionEvents.messages;
        }

        // ── Memory retrieval ──
        const memoryQuery = this.buildMemoryQuery(messages);
        const memoryScope = {
          org_id: ctx.scope.orgId,
          user_id: ctx.scope.userId,
          ...(ctx.scope.projectId ? { project_id: ctx.scope.projectId } : {}),
        };
        const memoryHits = ctx.groupId
          ? await this.config.memoryService.memory_search_tiered({
              query: memoryQuery,
              scope: memoryScope,
              top_k: 6,
              group_id: ctx.groupId,
              agent_instance_id: ctx.agentInstanceId,
            })
          : await this.config.memoryService.memory_search_pa({
              query: memoryQuery,
              scope: memoryScope,
              top_k: 6,
              ...(ctx.agentInstanceId ? { agent_instance_id: ctx.agentInstanceId } : {}),
            });
        lastMemoryHits = memoryHits;

        // ── Compose prompt via PromptComposer ──
        const skills = this.config.toolRouter.listSkills();
        const tools = this.config.toolRouter.listTools();
        const composeInput: ComposeInput = {
          history: messages,
          memoryHits,
          skills,
          ...(this.config.skillInjections ? { skillInjections: this.config.skillInjections } : {}),
          ...(this.config.agentContext ? { agentContext: this.config.agentContext } : {}),
          ...(this.config.availableGroups ? { availableGroups: this.config.availableGroups } : {}),
          ...(this.config.workDir
            ? {
                environment: {
                  cwd: this.config.workDir,
                  date: new Date().toISOString().slice(0, 10),
                  availableToolNames: tools.map((t) => t.name),
                },
              }
            : {}),
          ...(this.budgetManager
            ? {
                budget: {
                  utilization: this.budgetManager.utilization,
                  currentStep: step,
                  maxSteps: this.maxSteps,
                  compactionCount: this.budgetManager.currentCompactionCount,
                },
              }
            : {}),
        };
        let contextMessages = this.promptComposer.compose(composeInput);
        const preflight = yield* this.ensureContextBudgetBeforeLLM(
          composeInput,
          contextMessages,
          messages,
          ctx,
          stepId,
          rootSpan,
          step
        );
        contextMessages = preflight.contextMessages;
        messages = preflight.messages;

        // ── LLM call ──
        const llmStarted = Date.now();
        const llmOptions = ctx.abortSignal ? { signal: ctx.abortSignal } : undefined;
        const response = llmClient.chatStream
          ? yield* this.callLLMStream(llmClient, contextMessages, tools, ctx, stepId, rootSpan)
          : await llmClient.chat(contextMessages, tools, llmOptions);
        this.throwIfAborted(ctx.abortSignal);
        const llmDuration = Date.now() - llmStarted;

        // Update budget tracker
        this.budgetManager?.update(response.usage);

        yield this.createEvent(ctx, stepId, rootSpan, 'llm.called', {
          model: this.config.modelConfig.model,
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          totalTokens: response.usage.totalTokens,
          duration_ms: llmDuration,
        });

        // ── Tool calls via ToolCallScheduler ──
        if (response.toolCalls && response.toolCalls.length > 0) {
          const normalizedToolCalls = this.normalizeToolCallsForStep(response.toolCalls, step);
          const toolHint = this.formatToolHint(normalizedToolCalls);
          yield this.createEvent(ctx, stepId, rootSpan, 'tool.hint', {
            hint: toolHint,
            tools: normalizedToolCalls.map((tc) => tc.name),
            tool_count: normalizedToolCalls.length,
          });

          if (step >= this.maxSteps) {
            yield this.createEvent(ctx, stepId, rootSpan, 'run.warning', {
              code: 'MAX_STEPS_FORCE_FINALIZE',
              message: `Reached step limit (${this.maxSteps}) with pending tool calls; forcing final synthesis.`,
            });

            let forcedResponse: LLMResponse | null = null;
            try {
              const forcedStarted = Date.now();
              forcedResponse = await this.requestForcedFinalAnswer(
                llmClient,
                contextMessages,
                response.content,
                ctx
              );
              this.throwIfAborted(ctx.abortSignal);
              const forcedDuration = Date.now() - forcedStarted;
              this.budgetManager?.update(forcedResponse.usage);

              yield this.createEvent(ctx, stepId, rootSpan, 'llm.called', {
                model: this.config.modelConfig.model,
                promptTokens: forcedResponse.usage.promptTokens,
                completionTokens: forcedResponse.usage.completionTokens,
                totalTokens: forcedResponse.usage.totalTokens,
                duration_ms: forcedDuration,
              });
            } catch (finalizeError) {
              yield this.createEvent(ctx, stepId, rootSpan, 'run.warning', {
                code: 'MAX_STEPS_FORCE_FINALIZE_FAILED',
                message: `Forced final synthesis failed: ${finalizeError instanceof Error ? finalizeError.message : String(finalizeError)}`,
              });
            }

            const finalOutput = this.sanitizeFinalOutput(
              forcedResponse?.content || response.content || this.buildMaxStepsOutput()
            );
            messages.push({ role: 'assistant', content: finalOutput });
            lastSavedMessageCount = await this.saveCheckpoint(
              ctx,
              stepId,
              messages,
              lastSavedMessageCount,
              memoryHits,
              lastToolResult
            );

            yield this.createEvent(ctx, stepId, rootSpan, 'step.completed', {
              stepNumber: step,
              resultType: 'final_answer',
              duration_ms: Date.now() - stepStart,
            });

            yield this.createEvent(ctx, stepId, rootSpan, 'run.completed', {
              output: finalOutput,
              duration_ms: Date.now() - startedAt,
            });

            return {
              status: 'completed',
              output: finalOutput,
              steps,
            };
          }

          const lookupOnlyCalls = normalizedToolCalls.every((tc) => LOOKUP_TOOL_NAMES.has(tc.name));
          lookupOnlyToolStreak = lookupOnlyCalls ? lookupOnlyToolStreak + 1 : 0;
          const stepsRemaining = this.maxSteps - step;

          if (this.shouldForceFinalizeForLookupLoop(lookupOnlyToolStreak, stepsRemaining)) {
            yield this.createEvent(ctx, stepId, rootSpan, 'run.warning', {
              code: 'LOOKUP_LOOP_FORCE_FINALIZE',
              message: `Detected ${lookupOnlyToolStreak} consecutive lookup-tool steps with ${stepsRemaining} steps remaining; forcing final synthesis.`,
            });

            const forcedStarted = Date.now();
            const forcedResponse = await this.requestForcedFinalAnswer(
              llmClient,
              contextMessages,
              response.content,
              ctx
            );
            this.throwIfAborted(ctx.abortSignal);
            const forcedDuration = Date.now() - forcedStarted;
            this.budgetManager?.update(forcedResponse.usage);

            yield this.createEvent(ctx, stepId, rootSpan, 'llm.called', {
              model: this.config.modelConfig.model,
              promptTokens: forcedResponse.usage.promptTokens,
              completionTokens: forcedResponse.usage.completionTokens,
              totalTokens: forcedResponse.usage.totalTokens,
              duration_ms: forcedDuration,
            });

            const finalOutput = this.sanitizeFinalOutput(
              forcedResponse.content || response.content || this.buildMaxStepsOutput()
            );
            messages.push({ role: 'assistant', content: finalOutput });
            lastSavedMessageCount = await this.saveCheckpoint(
              ctx,
              stepId,
              messages,
              lastSavedMessageCount,
              memoryHits,
              lastToolResult
            );

            yield this.createEvent(ctx, stepId, rootSpan, 'step.completed', {
              stepNumber: step,
              resultType: 'final_answer',
              duration_ms: Date.now() - stepStart,
            });

            yield this.createEvent(ctx, stepId, rootSpan, 'run.completed', {
              output: finalOutput,
              duration_ms: Date.now() - startedAt,
            });

            return {
              status: 'completed',
              output: finalOutput,
              steps,
            };
          }

          // Doom-loop detection
          const doomDetected = this.detectRepeatedToolPattern(normalizedToolCalls);
          if (doomDetected) {
            yield this.createEvent(ctx, stepId, rootSpan, 'run.warning', {
              code: 'DOOM_LOOP_DETECTED',
              message: `Repeated identical tool calls detected (${DOOM_LOOP_THRESHOLD}x). Breaking loop.`,
            });
            messages.push({
              role: 'assistant',
              content: response.content,
              toolCalls: normalizedToolCalls,
            });
            const firstToolCall = normalizedToolCalls[0];
            if (firstToolCall) {
              messages.push({
                role: 'tool',
                content: 'Error: Doom loop detected �?you are repeating the same tool call with identical parameters. Try a different approach or provide a final answer.',
                toolCallId: firstToolCall.id,
              });
            }
            continue;
          }

          messages.push({
            role: 'assistant',
            content: response.content,
            toolCalls: normalizedToolCalls,
          });

          // Use ToolCallScheduler for batch execution
          const batchResult = await this.toolScheduler.executeBatch(
            normalizedToolCalls,
            this.config.toolRouter,
            {
              runId: ctx.runId,
              sessionKey: ctx.sessionKey,
              agentId: ctx.agentId,
              stepId,
              rootSpan,
              ...(this.config.agentContext ? { agentContext: this.config.agentContext } : {}),
              ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
              ...(ctx.onEvent ? { onEvent: ctx.onEvent } : {}),
              ...(ctx.onWaiting ? { onWaiting: ctx.onWaiting } : {}),
              ...(ctx.onResumed ? { onResumed: ctx.onResumed } : {}),
              ...(ctx.onSuspend ? { onSuspend: ctx.onSuspend } : {}),
            }
          );

          // Convert batch results to messages
          for (const execResult of batchResult.results) {
            const r = execResult.result;
            lastToolResult = r.success ? r.result : r.error;
            messages.push({
              role: 'tool',
              content: formatToolResultMessageContent(r),
              toolCallId: execResult.toolCall.id,
            });
          }

          // Yield all batch events
          for (const event of batchResult.events) {
            yield event;
          }

          lastSavedMessageCount = await this.saveCheckpoint(ctx, stepId, messages, lastSavedMessageCount, memoryHits, lastToolResult);

          yield this.createEvent(ctx, stepId, rootSpan, 'step.completed', {
            stepNumber: step,
            resultType: 'tool_call',
            duration_ms: Date.now() - stepStart,
          });
          continue;
        }

        lookupOnlyToolStreak = 0;

        // ── Final answer ──
        const finalOutput = this.sanitizeFinalOutput(response.content);
        messages.push({ role: 'assistant', content: finalOutput });
        lastSavedMessageCount = await this.saveCheckpoint(ctx, stepId, messages, lastSavedMessageCount, memoryHits, lastToolResult);

        yield this.createEvent(ctx, stepId, rootSpan, 'step.completed', {
          stepNumber: step,
          resultType: 'final_answer',
          duration_ms: Date.now() - stepStart,
        });

        yield this.createEvent(ctx, stepId, rootSpan, 'run.completed', {
          output: finalOutput,
          duration_ms: Date.now() - startedAt,
        });

        return {
          status: 'completed',
          output: finalOutput,
          steps,
        };
      }
      const maxStepId = generateStepId(Math.max(steps, 1));
      const output = this.buildMaxStepsOutput();
      messages.push({ role: 'assistant', content: output });
      lastSavedMessageCount = await this.saveCheckpoint(
        ctx,
        maxStepId,
        messages,
        lastSavedMessageCount,
        lastMemoryHits,
        lastToolResult
      );

      yield this.createEvent(ctx, maxStepId, rootSpan, 'run.warning', {
        code: 'MAX_STEPS_REACHED',
        message: `Maximum step limit reached (${this.maxSteps}); returning fallback final answer.`,
        context: { step: steps, maxSteps: this.maxSteps },
      });

      yield this.createEvent(ctx, maxStepId, rootSpan, 'run.completed', {
        output,
        duration_ms: Date.now() - startedAt,
      });

      return {
        status: 'completed',
        output,
        steps,
      };
    } catch (error) {
      if (error instanceof RunSuspendedError) {
        const stepId = generateStepId(Math.max(steps, 1));
        try {
          lastSavedMessageCount = await this.saveCheckpoint(
            ctx,
            stepId,
            messages,
            lastSavedMessageCount,
            lastMemoryHits,
            lastToolResult
          );
        } catch (saveError) {
          const saveErrorMessage = saveError instanceof Error ? saveError.message : String(saveError);
          yield this.createEvent(ctx, stepId, rootSpan, 'run.failed', {
            error: {
              code: 'CHECKPOINT_SAVE_FAILED',
              message: saveErrorMessage,
            },
          });
          return { status: 'failed', error: saveErrorMessage, steps };
        }
        yield this.createEvent(ctx, stepId, rootSpan, 'run.suspended', {
          toolCallId: error.toolCallId,
          toolName: error.toolName,
          reason: error.reason,
        });
        return { status: 'suspended', steps };
      }
      const message = error instanceof Error ? error.message : String(error);
      const stepId = generateStepId(Math.max(steps, 1));
      const code = error instanceof RunCancelledError ? 'RUN_CANCELLED' : 'AGENT_ERROR';
      yield this.createEvent(ctx, stepId, rootSpan, 'run.failed', {
        error: { code, message },
      });
      return { status: 'failed', error: message, steps };
    }
  }

  private async *callLLMStream(
    llmClient: ILLMClient,
    contextMessages: Message[],
    tools: ReturnType<RuntimeToolRouter['listTools']>,
    ctx: RunnerContext,
    stepId: string,
    rootSpan: string
  ): AsyncGenerator<Event, import('@openintern/types/agent.js').LLMResponse, void> {
    const llmOptions = ctx.abortSignal ? { signal: ctx.abortSignal } : undefined;
    const stream = llmClient.chatStream!(contextMessages, tools, llmOptions);
    let fullContent = '';
    let tokenIndex = 0;
    let finalToolCalls: ToolCall[] | undefined;
    let finalUsage: import('@openintern/types/agent.js').LLMResponse['usage'] = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };

    for await (const chunk of stream) {
      this.throwIfAborted(ctx.abortSignal);
      if (chunk.delta) {
        fullContent += chunk.delta;
        yield this.createEvent(ctx, stepId, rootSpan, 'llm.token', {
          token: chunk.delta,
          tokenIndex,
        });
        tokenIndex++;
      }
      if (chunk.toolCalls) {
        finalToolCalls = chunk.toolCalls;
      }
      if (chunk.usage) {
        finalUsage = chunk.usage;
      }
    }

    return {
      content: fullContent,
      toolCalls: finalToolCalls,
      usage: finalUsage,
    };
  }

  private buildMemoryQuery(messages: Message[]): string {
    const recent = messages.slice(-4).map((msg) => `${msg.role}: ${getMessageText(msg.content)}`).join('\n');
    return recent || 'recent context';
  }

  /**
   * Doom-loop detection: track tool call signatures and detect repeated patterns.
   * Returns true if the same tool+params signature repeats >= DOOM_LOOP_THRESHOLD times.
   */
  private detectRepeatedToolPattern(toolCalls: ToolCall[]): boolean {
    const signature = toolCalls
      .map((tc) => `${tc.name}:${JSON.stringify(tc.parameters)}`)
      .sort()
      .join('|');

    this.recentToolSignatures.push(signature);
    if (this.recentToolSignatures.length > DOOM_LOOP_THRESHOLD * 2) {
      this.recentToolSignatures.splice(0, this.recentToolSignatures.length - DOOM_LOOP_THRESHOLD * 2);
    }

    const tail = this.recentToolSignatures.slice(-DOOM_LOOP_THRESHOLD);
    if (tail.length < DOOM_LOOP_THRESHOLD) return false;
    return tail.every((s) => s === signature);
  }

  /**
   * Canonicalize provider-returned tool call IDs into deterministic runtime IDs.
   * We do not rely on provider IDs being globally unique across turns.
   */
  private normalizeToolCallsForStep(toolCalls: ToolCall[], step: number): ToolCall[] {
    const seen = new Set<string>();
    return toolCalls.map((toolCall, index) => {
      const cleaned = toolCall.id
        .replace(/[^A-Za-z0-9_-]/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 64);
      const baseId = `tc_${step}_${index}${cleaned.length > 0 ? `_${cleaned}` : ''}`;
      let nextId = baseId;
      let suffix = 0;
      while (seen.has(nextId)) {
        suffix += 1;
        nextId = `${baseId}_${suffix}`;
      }
      seen.add(nextId);
      return {
        ...toolCall,
        id: nextId,
      };
    });
  }

  private shouldForceFinalizeForLookupLoop(
    lookupOnlyToolStreak: number,
    stepsRemaining: number
  ): boolean {
    return (
      lookupOnlyToolStreak >= LOOKUP_LOOP_STREAK_THRESHOLD
      && stepsRemaining <= LOOKUP_LOOP_STEPS_REMAINING_THRESHOLD
    );
  }

  private async requestForcedFinalAnswer(
    llmClient: ILLMClient,
    contextMessages: Message[],
    currentDraft: string,
    ctx: RunnerContext
  ): Promise<LLMResponse> {
    const forcedMessages: Message[] = [
      ...contextMessages,
      {
        role: 'assistant',
        content: this.stripThinkBlocks(currentDraft) || '(tool call proposed)',
      },
      {
        role: 'user',
        content: 'Stop using tools now. Based only on gathered evidence so far, provide the best possible final answer with concrete data and explicitly mark uncertainties.',
      },
    ];
    const llmOptions = ctx.abortSignal ? { signal: ctx.abortSignal } : undefined;
    return llmClient.chat(forcedMessages, undefined, llmOptions);
  }

  /**
   * Check context budget and auto-compact if needed.
   */
  private *maybeCompactContext(
    messages: Message[],
    ctx: RunnerContext,
    stepId: string,
    rootSpan: string,
    currentStep: number
  ): Generator<Event, { compacted: boolean; messages: Message[] }, void> {
    if (!this.budgetManager || !this.compactionService) {
      return { compacted: false, messages };
    }

    // Emit warning if approaching threshold
    if (this.budgetManager.shouldWarn()) {
      yield this.createEvent(ctx, stepId, rootSpan, 'run.warning', {
        code: 'CONTEXT_HIGH_WATER',
        message: `Context utilization at ${(this.budgetManager.utilization * 100).toFixed(0)}%`,
        context: { step: currentStep },
      });
    }

    // Compact if over threshold
    if (this.budgetManager.shouldCompact()) {
      logger.info('Triggering context compaction', {
        runId: ctx.runId,
        utilization: this.budgetManager.utilization,
      });

      const result = this.compactionService.compactMessages(messages);
      this.budgetManager.recordCompaction();

      yield this.createEvent(ctx, stepId, rootSpan, 'run.compacted', {
        messages_before: result.messages_before,
        messages_after: result.messages_after,
        tokens_saved: result.tokens_saved_estimate,
      });

      return { compacted: true, messages: result.messages };
    }

    return { compacted: false, messages };
  }

  /**
   * Perform preflight prompt-token budget check right before LLM call.
   * This catches sudden context spikes (usually from tool outputs) in the same step.
   */
  private async *ensureContextBudgetBeforeLLM(
    composeInput: ComposeInput,
    contextMessages: Message[],
    historyMessages: Message[],
    ctx: RunnerContext,
    stepId: string,
    rootSpan: string,
    currentStep: number
  ): AsyncGenerator<Event, { contextMessages: Message[]; messages: Message[] }, void> {
    if (!this.budgetManager || !this.compactionService) {
      return { contextMessages, messages: historyMessages };
    }

    let messages = historyMessages;
    let llmMessages = contextMessages;

    for (let attempt = 0; attempt < PREFLIGHT_COMPACTION_ATTEMPTS; attempt++) {
      const promptTokens = await this.promptTokenCounter.countMessages(llmMessages);
      if (this.budgetManager.shouldCompactForPrompt(promptTokens)) {
        logger.info('Preflight prompt compaction triggered', {
          runId: ctx.runId,
          step: currentStep,
          promptTokens,
        });

        const result = this.compactionService.compactMessages(messages);
        if (result.messages_after >= result.messages_before) {
          break;
        }

        messages = result.messages;
        this.budgetManager.recordCompaction();
        yield this.createEvent(ctx, stepId, rootSpan, 'run.compacted', {
          messages_before: result.messages_before,
          messages_after: result.messages_after,
          tokens_saved: result.tokens_saved_estimate,
        });
        llmMessages = this.promptComposer.compose({
          ...composeInput,
          history: messages,
        });
        continue;
      }

      if (this.budgetManager.shouldWarnForPrompt(promptTokens)) {
        yield this.createEvent(ctx, stepId, rootSpan, 'run.warning', {
          code: 'PROMPT_CONTEXT_HIGH_WATER',
          message: `Prompt is near context limit (${promptTokens} tokens before completion).`,
          context: { step: currentStep },
        });
      }

      return { contextMessages: llmMessages, messages };
    }

    const finalPromptTokens = await this.promptTokenCounter.countMessages(llmMessages);
    if (this.budgetManager.shouldCompactForPrompt(finalPromptTokens)) {
      yield this.createEvent(ctx, stepId, rootSpan, 'run.warning', {
        code: 'PROMPT_CONTEXT_STILL_HIGH',
        message: `Prompt remains above compaction threshold (${finalPromptTokens} tokens).`,
        context: { step: currentStep },
      });
    } else if (this.budgetManager.shouldWarnForPrompt(finalPromptTokens)) {
      yield this.createEvent(ctx, stepId, rootSpan, 'run.warning', {
        code: 'PROMPT_CONTEXT_HIGH_WATER',
        message: `Prompt is near context limit (${finalPromptTokens} tokens before completion).`,
        context: { step: currentStep },
      });
    }

    return { contextMessages: llmMessages, messages };
  }

  private async saveCheckpoint(
    ctx: RunnerContext,
    stepId: string,
    messages: Message[],
    lastSavedMessageCount: number,
    memoryHits: Array<{ id: string; snippet: string; score: number; type: string }>,
    lastToolResult: unknown
  ): Promise<number> {
    await this.config.checkpointService.save(
      ctx.runId,
      ctx.agentId,
      stepId,
      messages,
      lastSavedMessageCount,
      {
        memory_hits: memoryHits,
        last_tool_result: lastToolResult,
        plan: 'single-agent-loop',
        budget_state: this.budgetManager?.getState(),
      }
    );
    return messages.length;
  }

  private createEvent<T extends EventType>(
    ctx: RunnerContext,
    stepId: string,
    rootSpan: string,
    type: T,
    payload: Extract<Event, { type: T }>['payload']
  ): Extract<Event, { type: T }> {
    return {
      v: 1,
      ts: new Date().toISOString(),
      session_key: ctx.sessionKey,
      run_id: ctx.runId,
      agent_id: ctx.agentId,
      step_id: stepId,
      span_id: generateSpanId(),
      parent_span_id: rootSpan,
      redaction: { contains_secrets: false },
      type,
      payload,
    } as Extract<Event, { type: T }>;
  }

  private createToolResultEvent(
    ctx: RunnerContext,
    stepId: string,
    rootSpan: string,
    toolName: string,
    result: ToolResult
  ): Extract<Event, { type: 'tool.result' }> {
    return this.createEvent(ctx, stepId, rootSpan, 'tool.result', {
      toolName,
      result: summarizeToolResultForEvent(result),
      isError: !result.success,
      ...(result.success
        ? {}
        : {
            error: {
              code: 'TOOL_ERROR',
              message: result.error ?? 'Unknown tool error',
            },
          }),
    });
  }
}





