/**
 * RetryPolicy - Exponential backoff retry with jitter
 *
 * Config: maxRetries=3, baseDelay=1s, maxDelay=30s
 */

import type { RetryConfig } from '@openintern/types/agent.js';
import { classifyError } from './error-classifier.js';
import { logger } from '@openintern/utils';

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
};

/**
 * Calculate delay with exponential backoff and jitter
 */
function calculateDelay(attempt: number, config: RetryConfig): number {
  const exponential = config.baseDelayMs * Math.pow(2, attempt);
  const capped = Math.min(exponential, config.maxDelayMs);
  // Add jitter: 50-100% of calculated delay
  const jitter = capped * (0.5 + Math.random() * 0.5);
  return Math.floor(jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RetryPolicy {
  private config: RetryConfig;

  constructor(config?: Partial<RetryConfig>) {
    this.config = { ...DEFAULT_RETRY_CONFIG, ...config };
  }

  /**
   * Execute a function with retry logic.
   * Only retries on retryable errors (429, 500, network, etc.)
   * Fatal errors are thrown immediately.
   */
  async execute<T>(
    fn: () => Promise<T>,
    context?: string,
  ): Promise<{ result: T; attempts: number }> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const result = await fn();
        return { result, attempts: attempt + 1 };
      } catch (error) {
        const classified = classifyError(error);

        if (classified.category === 'fatal') {
          throw classified.originalError;
        }

        lastError = classified.originalError;

        if (attempt < this.config.maxRetries) {
          const delay = calculateDelay(attempt, this.config);
          logger.warn('Retryable error, backing off', {
            context,
            attempt: attempt + 1,
            maxRetries: this.config.maxRetries,
            delayMs: delay,
            reason: classified.reason,
          });
          await sleep(delay);
        }
      }
    }

    throw lastError ?? new Error('Retry exhausted');
  }
}

