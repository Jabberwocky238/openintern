/**
 * TokenCounter - Accurate token counting with CJK heuristic fallback
 *
 * Uses js-tiktoken for precise BPE token counting.
 * Falls back to CJK-aware heuristic if tiktoken fails to initialize.
 */

import { logger } from '@openintern/utils';
import type { ContentPart } from '@openintern/types/agent.js';

/** CJK Unicode ranges */
const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\u{20000}-\u{2a6df}\u{2a700}-\u{2b73f}\u{2b740}-\u{2b81f}\u{2b820}-\u{2ceaf}\u{2ceb0}-\u{2ebef}\u{30000}-\u{3134f}\u3000-\u303f\uff00-\uffef]/gu;

/**
 * Heuristic token estimation for mixed CJK/Latin text.
 * - CJK characters: ~1.5 tokens each (empirical average for GPT tokenizers)
 * - Latin/other: ~4 characters per token
 */
function heuristicCount(text: string): number {
  let cjkChars = 0;
  for (const match of text.matchAll(CJK_REGEX)) {
    cjkChars += match[0].length;
  }
  const nonCjkChars = text.length - cjkChars;
  return Math.ceil(cjkChars * 1.5 + nonCjkChars / 4);
}

type TiktokenEncoder = { encode: (text: string) => number[] | Uint32Array; free?: () => void };

export class TokenCounter {
  private encoder: TiktokenEncoder | null = null;
  private initAttempted = false;

  /**
   * Lazily initialize the tiktoken encoder.
   * Returns true if encoder is available.
   */
  private async ensureEncoder(): Promise<boolean> {
    if (this.encoder) return true;
    if (this.initAttempted) return false;

    this.initAttempted = true;
    try {
      const { encodingForModel } = await import('js-tiktoken');
      this.encoder = encodingForModel('gpt-4o') as TiktokenEncoder;
      return true;
    } catch (err) {
      logger.warn('Failed to initialize tiktoken, using heuristic fallback', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Count tokens in a string.
   * Uses tiktoken if available, otherwise CJK-aware heuristic.
   */
  async count(text: string): Promise<number> {
    if (!text) return 0;

    const hasEncoder = await this.ensureEncoder();
    if (hasEncoder && this.encoder) {
      try {
        const tokens = this.encoder.encode(text);
        return Array.isArray(tokens) ? tokens.length : tokens.length;
      } catch {
        return heuristicCount(text);
      }
    }

    return heuristicCount(text);
  }

  /**
   * Synchronous heuristic count (no tiktoken, always available).
   */
  countSync(text: string): number {
    if (!text) return 0;

    if (this.encoder) {
      try {
        const tokens = this.encoder.encode(text);
        return Array.isArray(tokens) ? tokens.length : tokens.length;
      } catch {
        return heuristicCount(text);
      }
    }

    return heuristicCount(text);
  }

  /**
   * Count tokens for an array of messages.
   * Handles both string and ContentPart[] content.
   * Images are estimated at ~85 tokens each (low-res thumbnail estimate).
   */
  async countMessages(messages: Array<{ content: string | ContentPart[] }>): Promise<number> {
    let total = 0;
    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') {
            total += await this.count(part.text);
          } else if (part.type === 'image') {
            total += 85; // approximate token cost for an image
          }
        }
      } else {
        total += await this.count(msg.content);
      }
      total += 4; // per-message overhead (role, separators)
    }
    return total;
  }
}

