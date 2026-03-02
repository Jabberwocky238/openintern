/**
 * ContextTrimmer - Turn-based message trimming with tool call integrity protection
 *
 * Features:
 * - Groups messages into conversation turns (user + assistant + tool results)
 * - Preserves first user message (task context) and recent N turns
 * - Never orphans tool result messages from their assistant toolCalls
 * - Pre-compaction memory flush hook
 */

import type { Message } from '@openintern/types/agent.js';
import { TokenCounter } from './token-counter.js';
import { logger } from '@openintern/utils';

/**
 * A conversation turn: one user/assistant exchange plus any tool interactions
 */
export interface ConversationTurn {
  messages: Message[];
  tokenCount: number;
}

export interface ContextTrimmerConfig {
  /** Minimum number of recent turns to preserve */
  preserveTurns: number;
  /** Whether to always keep the first user message */
  preserveFirstUserMessage: boolean;
}

const DEFAULT_TRIMMER_CONFIG: ContextTrimmerConfig = {
  preserveTurns: 3,
  preserveFirstUserMessage: true,
};

export class ContextTrimmer {
  private config: ContextTrimmerConfig;
  private tokenCounter: TokenCounter;

  constructor(
    tokenCounter: TokenCounter,
    config: Partial<ContextTrimmerConfig> = {},
  ) {
    this.config = { ...DEFAULT_TRIMMER_CONFIG, ...config };
    this.tokenCounter = tokenCounter;
  }

  /**
   * Group messages into conversation turns.
   * A turn starts with a user message and includes all subsequent
   * assistant/tool messages until the next user message.
   */
  groupIntoTurns(messages: Message[]): ConversationTurn[] {
    const turns: ConversationTurn[] = [];
    let current: Message[] = [];

    for (const msg of messages) {
      if (msg.role === 'user' && current.length > 0) {
        turns.push({ messages: current, tokenCount: 0 });
        current = [];
      }
      current.push(msg);
    }

    if (current.length > 0) {
      turns.push({ messages: current, tokenCount: 0 });
    }

    return turns;
  }

  /**
   * Compute token counts for each turn.
   */
  async computeTurnTokens(turns: ConversationTurn[]): Promise<void> {
    for (const turn of turns) {
      turn.tokenCount = await this.tokenCounter.countMessages(turn.messages);
    }
  }

  /**
   * Trim messages to fit within the token budget.
   * Preserves the first user message and the most recent N turns.
   * Removes oldest turns from the middle.
   */
  async trim(messages: Message[], maxTokens: number): Promise<Message[]> {
    if (messages.length === 0) return [];

    const turns = this.groupIntoTurns(messages);
    await this.computeTurnTokens(turns);

    const totalTokens = turns.reduce((sum, t) => sum + t.tokenCount, 0);

    // If within budget, return as-is
    if (totalTokens <= maxTokens) {
      return messages;
    }

    // Determine which turns to keep
    const preserveTurns = Math.min(this.config.preserveTurns, turns.length);
    const keepFirst = this.config.preserveFirstUserMessage ? 1 : 0;

    // If we only have enough turns for head + tail, keep all
    if (turns.length <= keepFirst + preserveTurns) {
      return messages;
    }

    // Start with head (first turn) and tail (recent turns)
    const headTurns = turns.slice(0, keepFirst);
    const tailStart = Math.max(keepFirst, turns.length - preserveTurns);
    const tailTurns = turns.slice(tailStart);

    // Calculate tokens for head + tail
    let keptTokens = 0;
    for (const t of headTurns) keptTokens += t.tokenCount;
    for (const t of tailTurns) keptTokens += t.tokenCount;

    // If head + tail already exceeds budget, trim tail turns
    if (keptTokens > maxTokens && tailTurns.length > 1) {
      while (keptTokens > maxTokens && tailTurns.length > 1) {
        const removed = tailTurns.shift()!;
        keptTokens -= removed.tokenCount;
      }
    }

    // Try to add middle turns (newest first) if budget allows
    const middleTurns = turns.slice(keepFirst, tailStart);
    const addedMiddle: ConversationTurn[] = [];

    for (let i = middleTurns.length - 1; i >= 0; i--) {
      const turn = middleTurns[i]!;
      if (keptTokens + turn.tokenCount <= maxTokens) {
        addedMiddle.unshift(turn);
        keptTokens += turn.tokenCount;
      }
    }

    // Assemble final message list
    const result: Message[] = [];
    for (const t of headTurns) result.push(...t.messages);
    for (const t of addedMiddle) result.push(...t.messages);
    for (const t of tailTurns) result.push(...t.messages);

    logger.debug('Context trimmed', {
      originalTurns: turns.length,
      keptTurns: headTurns.length + addedMiddle.length + tailTurns.length,
      originalMessages: messages.length,
      keptMessages: result.length,
      estimatedTokens: keptTokens,
    });

    return result;
  }

  /**
   * Validate that no tool result messages are orphaned.
   * Returns true if all tool results have a preceding assistant
   * message with matching toolCalls.
   */
  validateToolCallIntegrity(messages: Message[]): boolean {
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      if (msg.role === 'tool' && msg.toolCallId) {
        // Look backwards for an assistant message with matching toolCalls
        let found = false;
        for (let j = i - 1; j >= 0; j--) {
          const prev = messages[j]!;
          if (prev.role === 'assistant' && prev.toolCalls) {
            if (prev.toolCalls.some((tc) => tc.id === msg.toolCallId)) {
              found = true;
              break;
            }
          }
        }
        if (!found) {
          logger.warn('Orphaned tool result detected', {
            toolCallId: msg.toolCallId,
            index: i,
          });
          return false;
        }
      }
    }
    return true;
  }
}

