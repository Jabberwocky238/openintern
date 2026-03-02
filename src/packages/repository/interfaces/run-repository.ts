import type { Event } from '../../../types/events.js';
import type { RunMeta } from '../../../types/run.js';
import type { IPostgresClient } from './postgres-client.js';
import type {
  DelegatedPermissions,
  EventCursorPage,
  RunCreateInput,
  RunDependency,
  RunRecord,
} from '../../../backend/runtime/models.js';
import type { ScopeContext } from '../../shared/scope.js';

export interface RunMessageRecord {
  role: string;
  content: unknown;
  toolCallId?: string;
  toolCalls?: unknown;
}

export interface IRunRepository {
  createRun(input: RunCreateInput): Promise<RunRecord>;
  getRun(runId: string, scope: ScopeContext): Promise<RunRecord | null>;
  requireRun(runId: string, scope: ScopeContext): Promise<RunRecord>;
  setRunRunning(runId: string): Promise<void>;
  setRunCompleted(runId: string, output: string): Promise<void>;
  setRunFailed(runId: string, error: { code: string; message: string }): Promise<void>;
  setRunCancelled(runId: string): Promise<void>;
  setRunWaiting(runId: string): Promise<void>;
  setRunResumed(runId: string): Promise<void>;
  setRunSuspended(runId: string, reason: string): Promise<void>;
  setRunResumedFromSuspension(runId: string): Promise<void>;
  getRunById(runId: string): Promise<RunRecord | null>;
  listRunsBySession(
    scope: ScopeContext,
    sessionKey: string,
    page: number,
    limit: number
  ): Promise<{ runs: RunMeta[]; total: number }>;
  listSessionHistory(
    scope: ScopeContext,
    sessionKey: string,
    limit: number
  ): Promise<Array<{ id: string; input: string; result: string | null }>>;
  getChildRuns(parentRunId: string): Promise<RunMeta[]>;
  appendEvent(event: Event): Promise<number>;
  appendEvents(events: Event[]): Promise<number[]>;
  getRunEvents(
    runId: string,
    scope: ScopeContext,
    cursor: string | undefined,
    limit: number,
    includeTokens?: boolean
  ): Promise<EventCursorPage<Event>>;
  createCheckpoint(
    runId: string,
    agentId: string,
    stepId: string,
    state: Record<string, unknown>,
    client?: IPostgresClient
  ): Promise<void>;
  getLatestCheckpoint(
    runId: string,
    agentId: string
  ): Promise<{ stepId: string; state: Record<string, unknown> } | null>;
  cancelPendingRun(runId: string, scope: ScopeContext, client?: IPostgresClient): Promise<boolean>;
  appendMessages(
    runId: string,
    agentId: string,
    stepId: string,
    messages: RunMessageRecord[],
    startOrdinal: number,
    client?: IPostgresClient
  ): Promise<void>;
  saveCheckpointSnapshot(input: {
    runId: string;
    agentId: string;
    stepId: string;
    messages: RunMessageRecord[];
    startOrdinal: number;
    state: Record<string, unknown>;
  }): Promise<void>;
  loadMessages(runId: string, agentId: string): Promise<RunMessageRecord[]>;
  countEventsAndTools(runId: string): Promise<{ eventCount: number; toolCalls: number }>;
  createDependency(
    parentRunId: string,
    childRunId: string,
    toolCallId: string,
    roleId: string | null,
    goal: string
  ): Promise<RunDependency>;
  completeDependencyAtomic(
    childRunId: string,
    status: 'completed' | 'failed',
    result?: string,
    error?: string
  ): Promise<{ dep: RunDependency; pendingCount: number } | null>;
  listDependenciesByParent(parentRunId: string): Promise<RunDependency[]>;
  getDependencyByChild(childRunId: string): Promise<RunDependency | null>;
}

export type { DelegatedPermissions };


