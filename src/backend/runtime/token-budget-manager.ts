import type { BudgetState } from '@openintern/types/agent.js';
import { logger } from '@openintern/utils';

export interface TokenBudgetManagerConfig {
  /** Maximum context window tokens for the model (default: 128000) */
  maxContextTokens?: number;
  /** Utilization threshold to trigger compaction (0-1, default 0.8) */
  compactionThreshold?: number;
  /** Utilization threshold to emit a warning (0-1, default 0.7) */
  warningThreshold?: number;
  /** Minimum tokens to reserve for response generation */
  reserveTokens?: number;
}

const DEFAULT_MAX_CONTEXT = 128000;
const DEFAULT_COMPACTION_THRESHOLD = 0.8;
const DEFAULT_WARNING_THRESHOLD = 0.7;
const DEFAULT_RESERVE_TOKENS = 4096;

/**
 * TokenBudgetManager tracks prompt/response token usage trends
 * and determines when compaction or warnings should be triggered.
 */
export class TokenBudgetManager {
  private readonly maxContextTokens: number;
  private readonly compactionThreshold: number;
  private readonly warningThreshold: number;
  private readonly reserveTokens: number;

  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;
  private lastPromptTokens = 0;
  private compactionCount = 0;
  private lastCompactedAt?: string;

  constructor(config?: TokenBudgetManagerConfig) {
    this.maxContextTokens = config?.maxContextTokens ?? DEFAULT_MAX_CONTEXT;
    this.compactionThreshold = config?.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD;
    this.warningThreshold = config?.warningThreshold ?? DEFAULT_WARNING_THRESHOLD;
    this.reserveTokens = config?.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
  }

  /**
   * Update with latest LLM usage from a step.
   */
  update(usage: { promptTokens: number; completionTokens: number }): void {
    this.lastPromptTokens = usage.promptTokens;
    this.totalPromptTokens += usage.promptTokens;
    this.totalCompletionTokens += usage.completionTokens;
  }

  /**
   * Current utilization ratio based on last prompt size vs available window.
   */
  get utilization(): number {
    return this.getUtilizationForPrompt(this.lastPromptTokens);
  }

  getUtilizationForPrompt(promptTokens: number): number {
    const available = this.maxContextTokens - this.reserveTokens;
    if (available <= 0) return 1;
    return Math.min(1, promptTokens / available);
  }

  /**
   * Whether compaction should be triggered.
   */
  shouldCompact(): boolean {
    return this.utilization >= this.compactionThreshold;
  }

  shouldCompactForPrompt(promptTokens: number): boolean {
    return this.getUtilizationForPrompt(promptTokens) >= this.compactionThreshold;
  }

  /**
   * Whether a budget warning should be emitted.
   */
  shouldWarn(): boolean {
    return this.utilization >= this.warningThreshold && !this.shouldCompact();
  }

  shouldWarnForPrompt(promptTokens: number): boolean {
    const utilization = this.getUtilizationForPrompt(promptTokens);
    return utilization >= this.warningThreshold && utilization < this.compactionThreshold;
  }

  /**
   * Record that a compaction occurred.
   */
  recordCompaction(): void {
    this.compactionCount++;
    this.lastCompactedAt = new Date().toISOString();
    logger.info('Token budget compaction recorded', {
      compactionCount: this.compactionCount,
    });
  }

  /**
   * Get current budget state for checkpoint/event serialization.
   */
  getState(): BudgetState {
    return {
      total_tokens_used: this.totalPromptTokens + this.totalCompletionTokens,
      max_context_tokens: this.maxContextTokens,
      utilization: this.utilization,
      compaction_count: this.compactionCount,
      last_compacted_at: this.lastCompactedAt,
    };
  }

  get currentCompactionCount(): number {
    return this.compactionCount;
  }
}

