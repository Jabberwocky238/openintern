/**
 * Patterns that indicate sensitive data
 */
const SECRET_PATTERNS = [
  /api[_-]?key/i,
  /token/i,
  /password/i,
  /secret/i,
  /bearer\s+\S+/i,
  /authorization/i,
  /credential/i,
  /private[_-]?key/i,
];

/**
 * Redaction result
 */
export interface RedactResult {
  redacted: unknown;
  containsSecrets: boolean;
}

/**
 * Check if a key matches any secret pattern
 */
function isSecretKey(key: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Redact secrets from an object
 */
export function redactSecrets(obj: unknown): RedactResult {
  let containsSecrets = false;

  function redactValue(value: unknown, key?: string): unknown {
    if (key && isSecretKey(key) && typeof value === 'string') {
      containsSecrets = true;
      return '[REDACTED]';
    }

    if (value === null || value === undefined) {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item));
    }

    if (typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = redactValue(v, k);
      }
      return result;
    }

    return value;
  }

  const redacted = redactValue(obj);
  return { redacted, containsSecrets };
}
