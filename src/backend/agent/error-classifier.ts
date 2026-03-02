/**
 * ErrorClassifier - Classify errors as retryable or fatal
 *
 * Retryable: 429 (rate limit), 500/502/503 (server), network, timeout
 * Fatal: validation, permission, sandbox, unknown
 */

import { ValidationError, LLMError } from '../../utils/errors.js';

export type ErrorCategory = 'retryable' | 'fatal';

export interface ClassifiedError {
  category: ErrorCategory;
  reason: string;
  originalError: Error;
  httpStatus?: number;
}

/** HTTP status codes that indicate transient server errors */
const RETRYABLE_HTTP_CODES = new Set([429, 500, 502, 503, 504]);

/** Error message patterns that indicate network/transient issues */
const RETRYABLE_PATTERNS = [
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /socket hang up/i,
  /network/i,
  /timeout/i,
  /rate.?limit/i,
  /too many requests/i,
  /service.?unavailable/i,
  /bad gateway/i,
  /gateway timeout/i,
];

/** Error types that should never be retried */
const FATAL_ERROR_NAMES = new Set([
  'ValidationError',
  'SandboxError',
  'NotFoundError',
]);

export function classifyError(error: unknown): ClassifiedError {
  const err = error instanceof Error ? error : new Error(String(error));

  // Fatal: known non-retryable error types
  if (FATAL_ERROR_NAMES.has(err.name)) {
    return {
      category: 'fatal',
      reason: `Non-retryable error type: ${err.name}`,
      originalError: err,
    };
  }

  if (error instanceof ValidationError) {
    return {
      category: 'fatal',
      reason: 'Validation error',
      originalError: err,
    };
  }

  // LLM errors: check HTTP status
  if (error instanceof LLMError) {
    const status = error.httpStatus;
    if (status && RETRYABLE_HTTP_CODES.has(status)) {
      return {
        category: 'retryable',
        reason: `LLM API returned ${status}`,
        originalError: err,
        httpStatus: status,
      };
    }
    // LLM errors without retryable status are fatal
    const result: ClassifiedError = {
      category: 'fatal',
      reason: `LLM error (HTTP ${status ?? 'unknown'})`,
      originalError: err,
    };
    if (status !== undefined) {
      result.httpStatus = status;
    }
    return result;
  }

  // Check error message for retryable patterns
  const message = err.message;
  for (const pattern of RETRYABLE_PATTERNS) {
    if (pattern.test(message)) {
      return {
        category: 'retryable',
        reason: `Message matches retryable pattern: ${pattern.source}`,
        originalError: err,
      };
    }
  }

  // Default: fatal
  return {
    category: 'fatal',
    reason: 'Unrecognized error, treating as fatal',
    originalError: err,
  };
}

