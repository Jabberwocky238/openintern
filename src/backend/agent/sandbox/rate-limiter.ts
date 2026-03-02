/**
 * ToolRateLimiter - Sliding window rate limiting for tool calls
 */

import { SandboxError } from '../../../utils/errors.js';
import { logger } from '../../../utils/logger.js';

export interface RateLimiterConfig {
  maxCalls: number;
  windowMs: number;
}

const DEFAULT_CONFIG: RateLimiterConfig = {
  maxCalls: 60,
  windowMs: 60000, // 1 minute
};

export class ToolRateLimiter {
  private config: RateLimiterConfig;
  private timestamps: Map<string, number[]> = new Map();

  constructor(config?: Partial<RateLimiterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if a tool call is within rate limits.
   * Throws SandboxError if limit exceeded.
   */
  check(toolName: string): void {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    // Get or create timestamp list for this tool
    let times = this.timestamps.get(toolName);
    if (!times) {
      times = [];
      this.timestamps.set(toolName, times);
    }

    // Remove expired timestamps
    const filtered = times.filter((t) => t > windowStart);
    this.timestamps.set(toolName, filtered);

    if (filtered.length >= this.config.maxCalls) {
      logger.warn('Rate limit exceeded', {
        toolName,
        calls: filtered.length,
        maxCalls: this.config.maxCalls,
        windowMs: this.config.windowMs,
      });
      throw new SandboxError(
        `Rate limit exceeded for "${toolName}": ${filtered.length}/${this.config.maxCalls} calls in ${this.config.windowMs}ms`,
        'rate_limit_exceeded',
        { toolName, calls: filtered.length },
      );
    }

    // Record this call
    filtered.push(now);
  }

  /**
   * Reset rate limit counters
   */
  reset(): void {
    this.timestamps.clear();
  }
}

