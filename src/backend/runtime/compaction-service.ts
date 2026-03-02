import type { Message } from '../../types/agent.js';
import { getMessageText } from '../../types/agent.js';
import { logger } from '@openintern/utils';

export interface CompactionResult {
  messages: Message[];
  messages_before: number;
  messages_after: number;
  tokens_saved_estimate: number;
}

/**
 * CompactionService summarizes old messages and large tool outputs
 * to reduce context size while preserving essential information.
 */
export class CompactionService {
  /** Number of recent turns to always preserve uncompacted */
  private readonly preserveTurns: number;
  /** Max characters for a single tool output before truncation */
  private readonly maxToolOutputChars: number;

  constructor(opts?: { preserveTurns?: number; maxToolOutputChars?: number }) {
    this.preserveTurns = opts?.preserveTurns ?? 6;
    this.maxToolOutputChars = opts?.maxToolOutputChars ?? 8000;
  }

  /**
   * Compact a message array by summarizing older messages
   * and truncating large tool outputs.
   */
  compactMessages(messages: Message[]): CompactionResult {
    const before = messages.length;
    if (before <= this.preserveTurns + 1) {
      return {
        messages,
        messages_before: before,
        messages_after: before,
        tokens_saved_estimate: 0,
      };
    }

    const preserved = messages.slice(-this.preserveTurns);
    const older = messages.slice(0, -this.preserveTurns);

    // Summarize older messages into a single system-level summary
    const summary = this.summarizeMessages(older);
    // Truncate large tool outputs in preserved messages
    const compactedPreserved = preserved.map((m) => this.compactToolOutput(m));

    const result: Message[] = [
      { role: 'system', content: `[Compacted context summary]\n${summary}` },
      ...compactedPreserved,
    ];

    const charsBefore = messages.reduce((s, m) => s + getMessageText(m.content).length, 0);
    const charsAfter = result.reduce((s, m) => s + getMessageText(m.content).length, 0);
    const tokensSaved = Math.max(0, Math.floor((charsBefore - charsAfter) / 4));

    logger.info('Context compacted', {
      messages_before: before,
      messages_after: result.length,
      tokens_saved_estimate: tokensSaved,
    });

    return {
      messages: result,
      messages_before: before,
      messages_after: result.length,
      tokens_saved_estimate: tokensSaved,
    };
  }

  /**
   * Compact large tool outputs within a single message.
   */
  compactToolOutput(message: Message): Message {
    const text = getMessageText(message.content);
    if (message.role !== 'tool' || text.length <= this.maxToolOutputChars) {
      return message;
    }
    const truncated = text.slice(0, this.maxToolOutputChars)
      + `\n... [truncated, ${text.length - this.maxToolOutputChars} chars omitted]`;
    return { ...message, content: truncated };
  }

  private summarizeMessages(messages: Message[]): string {
    const lines: string[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') continue;

      const text = getMessageText(msg.content);
      const preview = text.slice(0, 200);
      if (msg.role === 'user') {
        lines.push(`User: ${preview}`);
      } else if (msg.role === 'assistant') {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          const toolNames = msg.toolCalls.map((tc) => tc.name).join(', ');
          lines.push(`Assistant called tools: ${toolNames}`);
        } else {
          lines.push(`Assistant: ${preview}`);
        }
      } else if (msg.role === 'tool') {
        const toolId = msg.toolCallId ?? 'unknown';
        const resultPreview = text.slice(0, 120);
        lines.push(`Tool result (${toolId}): ${resultPreview}`);
      }
    }

    return lines.join('\n');
  }
}

