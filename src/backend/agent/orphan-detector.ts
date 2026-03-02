/**
 * OrphanDetector - Detect orphaned tool calls after crash recovery
 *
 * When an agent crashes mid-execution, the last assistant message may have
 * toolCalls without corresponding tool result messages. This detector
 * finds such orphans and generates synthetic error results.
 */

import type { Message, ToolCall } from '@openintern/types/agent.js';
import { logger } from '@openintern/utils';

export interface OrphanedToolCall {
  toolCall: ToolCall;
  assistantIndex: number;
}

/**
 * Detect orphaned tool calls in a message history.
 * An orphaned tool call is an assistant message with toolCalls
 * that has no corresponding tool result message after it.
 */
export function detectOrphanedToolCalls(messages: Message[]): OrphanedToolCall[] {
  const orphans: OrphanedToolCall[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== 'assistant' || !msg.toolCalls || msg.toolCalls.length === 0) {
      continue;
    }

    // For each tool call, check if there's a matching tool result after this message
    for (const tc of msg.toolCalls) {
      let found = false;
      for (let j = i + 1; j < messages.length; j++) {
        const candidate = messages[j]!;
        if (candidate.role === 'tool' && candidate.toolCallId === tc.id) {
          found = true;
          break;
        }
      }
      if (!found) {
        orphans.push({ toolCall: tc, assistantIndex: i });
      }
    }
  }

  if (orphans.length > 0) {
    logger.warn('Orphaned tool calls detected', {
      count: orphans.length,
      toolCallIds: orphans.map((o) => o.toolCall.id),
    });
  }

  return orphans;
}

/**
 * Generate synthetic tool result messages for orphaned tool calls.
 */
export function generateSyntheticResults(orphans: OrphanedToolCall[]): Message[] {
  return orphans.map((orphan) => ({
    role: 'tool' as const,
    content: JSON.stringify({
      error: `Tool call interrupted: agent was restarted before "${orphan.toolCall.name}" could complete. Please retry if needed.`,
    }),
    toolCallId: orphan.toolCall.id,
  }));
}

