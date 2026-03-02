import type { Event } from '../../../types/events.js';
import type { RunMeta } from '../../../types/run.js';
import type { RunRecord } from '../../runtime/models.js';
import { durationMs } from './helpers.js';

type MessageType = NonNullable<Event['message_type']>;

const MESSAGE_TYPE_BY_EVENT_TYPE: Partial<Record<Event['type'], MessageType>> = {
  'message.task': 'TASK',
  'message.proposal': 'PROPOSAL',
  'message.decision': 'DECISION',
  'message.evidence': 'EVIDENCE',
  'message.status': 'STATUS',
};

function resolveRunMode(record: Pick<RunRecord, 'runMode' | 'groupId'>): 'single' | 'group' | 'plan_execute' {
  if (record.runMode) {
    return record.runMode;
  }
  return record.groupId ? 'group' : 'single';
}

export function resolveMessageType(
  eventType: Event['type'],
  explicit: Event['message_type'] | null | undefined
): MessageType | null {
  return explicit ?? MESSAGE_TYPE_BY_EVENT_TYPE[eventType] ?? null;
}

export function toMeta(run: RunRecord, events: Event[]): RunMeta {
  const startedAt = run.startedAt ?? run.createdAt;
  return {
    run_id: run.id,
    session_key: run.sessionKey,
    status: run.status,
    run_mode: resolveRunMode(run),
    started_at: startedAt,
    ended_at: run.endedAt,
    duration_ms: durationMs(startedAt, run.endedAt),
    event_count: events.length,
    tool_call_count: events.filter((event) => event.type === 'tool.called').length,
    parent_run_id: run.parentRunId ?? null,
  };
}
