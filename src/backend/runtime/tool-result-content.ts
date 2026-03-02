import type { ToolResult } from '../../types/agent.js';

// Keep tool payloads compact in persisted history to avoid context poisoning/looping.
const TOOL_RESULT_MESSAGE_MAX_CHARS = 1200;
const TOOL_RESULT_EVENT_MAX_CHARS = 800;

function truncateWithMarker(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n... [truncated, ${omitted} chars omitted]`;
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined) {
    return '(no result)';
  }
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      return '(no result)';
    }
    return serialized;
  } catch {
    return String(value);
  }
}

export function formatToolResultMessageContent(result: ToolResult): string {
  const prefix = result.humanInterventionNote
    ? `${result.humanInterventionNote}\n\n`
    : '';

  const body = result.success
    ? safeStringify(result.result)
    : `Error: ${result.error ?? 'Unknown tool error'}`;

  return truncateWithMarker(`${prefix}${body}`, TOOL_RESULT_MESSAGE_MAX_CHARS);
}

export function summarizeToolResultForEvent(result: ToolResult): unknown {
  const raw = result.result;

  if (raw === null || raw === undefined) {
    return raw;
  }

  if (typeof raw === 'string') {
    return truncateWithMarker(raw, TOOL_RESULT_EVENT_MAX_CHARS);
  }

  if (typeof raw === 'number' || typeof raw === 'boolean') {
    return raw;
  }

  const serialized = safeStringify(raw);
  if (serialized.length <= TOOL_RESULT_EVENT_MAX_CHARS) {
    return raw;
  }

  return {
    truncated: true,
    original_type: Array.isArray(raw) ? 'array' : typeof raw,
    original_length: serialized.length,
    preview: truncateWithMarker(serialized, TOOL_RESULT_EVENT_MAX_CHARS),
  };
}

