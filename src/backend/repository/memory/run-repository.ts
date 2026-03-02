import type { Event } from '../../../types/events.js';
import type { RunMeta } from '../../../types/run.js';
import { NotFoundError } from '@openintern/utils';
import type {
  DelegatedPermissions,
  EventCursorPage,
  RunCreateInput,
  RunRecord,
} from '../../runtime/models.js';
import type { ScopeContext } from '../shared/scope.js';
import type { IRunRepository } from '../interfaces/run-repository.js';
import { clone, matchesScope, nowIso } from './helpers.js';
import { resolveMessageType, toMeta } from './run-repository-helpers.js';
import { RunRepositoryStorageBase } from './run-repository-storage-base.js';
import { resolveMemoryRepositoryStore } from './store.js';
export class RunRepository extends RunRepositoryStorageBase implements IRunRepository {
  constructor(storeOrPool?: unknown) {
    super(resolveMemoryRepositoryStore(storeOrPool));
  }
  async createRun(input: RunCreateInput): Promise<RunRecord> {
    const run: RunRecord = {
      id: input.id,
      orgId: input.scope.orgId,
      userId: input.scope.userId,
      projectId: input.scope.projectId,
      groupId: input.groupId ?? null,
      sessionKey: input.sessionKey,
      input: input.input,
      status: 'pending',
      runMode: input.runMode ?? (input.groupId ? 'group' : 'single'),
      agentId: input.agentId,
      llmConfig: input.llmConfig,
      result: null,
      error: null,
      parentRunId: input.parentRunId ?? null,
      delegatedPermissions: (input.delegatedPermissions ?? null) as DelegatedPermissions | null,
      createdAt: nowIso(),
      startedAt: null,
      endedAt: null,
      cancelledAt: null,
      suspendedAt: null,
      suspendReason: null,
    };
    this.store.runs.set(run.id, clone(run));
    return clone(run);
  }
  async getRun(runId: string, scope: ScopeContext): Promise<RunRecord | null> {
    const run = this.store.runs.get(runId);
    if (!run || !matchesScope(scope, run)) {
      return null;
    }
    return clone(run);
  }
  async requireRun(runId: string, scope: ScopeContext): Promise<RunRecord> {
    const run = await this.getRun(runId, scope);
    if (!run) {
      throw new NotFoundError('Run', runId);
    }
    return run;
  }
  async setRunRunning(runId: string): Promise<void> {
    const run = this.store.runs.get(runId);
    if (run && run.status === 'pending') {
      this.store.runs.set(runId, { ...run, status: 'running', startedAt: run.startedAt ?? nowIso() });
    }
  }
  async setRunCompleted(runId: string, output: string): Promise<void> {
    const run = this.store.runs.get(runId);
    if (run && run.status === 'running') {
      this.store.runs.set(runId, {
        ...run,
        status: 'completed',
        endedAt: nowIso(),
        result: { output },
      });
    }
  }
  async setRunFailed(runId: string, error: { code: string; message: string }): Promise<void> {
    const run = this.store.runs.get(runId);
    if (run && run.status === 'running') {
      this.store.runs.set(runId, { ...run, status: 'failed', endedAt: nowIso(), error });
    }
  }
  async setRunCancelled(runId: string): Promise<void> {
    const run = this.store.runs.get(runId);
    if (!run || !['pending', 'running', 'waiting', 'suspended'].includes(run.status)) {
      return;
    }
    const now = nowIso();
    this.store.runs.set(runId, { ...run, status: 'cancelled', cancelledAt: now, endedAt: now });
  }
  async setRunWaiting(runId: string): Promise<void> {
    const run = this.store.runs.get(runId);
    if (run && run.status === 'running') {
      this.store.runs.set(runId, { ...run, status: 'waiting' });
    }
  }
  async setRunResumed(runId: string): Promise<void> {
    const run = this.store.runs.get(runId);
    if (run && run.status === 'waiting') {
      this.store.runs.set(runId, { ...run, status: 'running' });
    }
  }
  async setRunSuspended(runId: string, reason: string): Promise<void> {
    const run = this.store.runs.get(runId);
    if (run && run.status === 'running') {
      this.store.runs.set(runId, { ...run, status: 'suspended', suspendedAt: nowIso(), suspendReason: reason });
    }
  }
  async setRunResumedFromSuspension(runId: string): Promise<void> {
    const run = this.store.runs.get(runId);
    if (run && run.status === 'suspended') {
      this.store.runs.set(runId, { ...run, status: 'pending', suspendedAt: null, suspendReason: null });
    }
  }
  async getRunById(runId: string): Promise<RunRecord | null> {
    const run = this.store.runs.get(runId);
    return run ? clone(run) : null;
  }
  async listRunsBySession(
    scope: ScopeContext,
    sessionKey: string,
    page: number,
    limit: number
  ): Promise<{ runs: RunMeta[]; total: number }> {
    const filtered = [...this.store.runs.values()]
      .filter((run) => run.sessionKey === sessionKey && matchesScope(scope, run))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const offset = (page - 1) * limit;
    const pageRuns = filtered.slice(offset, offset + limit);
    const runs = pageRuns.map((run) => toMeta(run, this.eventsForRun(run.id)));
    return { runs, total: filtered.length };
  }
  async listSessionHistory(
    scope: ScopeContext,
    sessionKey: string,
    limit: number
  ): Promise<Array<{ id: string; input: string; result: string | null }>> {
    const rows = [...this.store.runs.values()]
      .filter(
        (run) =>
          run.sessionKey === sessionKey &&
          matchesScope(scope, run) &&
          run.status === 'completed' &&
          run.parentRunId === null
      )
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit)
      .reverse();
    return rows.map((run) => ({
      id: run.id,
      input: run.input,
      result: run.result && 'output' in run.result ? String(run.result.output) : null,
    }));
  }
  async getChildRuns(parentRunId: string): Promise<RunMeta[]> {
    return [...this.store.runs.values()]
      .filter((run) => run.parentRunId === parentRunId)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .map((run) => toMeta(run, this.eventsForRun(run.id)));
  }
  async appendEvent(event: Event): Promise<number> {
    const id = this.store.nextEventId++;
    const messageType = resolveMessageType(event.type, event.message_type);
    const normalized = {
      ...event,
      ...(messageType ? { message_type: messageType } : {}),
    } as Event;
    this.store.events.push({ id, event: clone(normalized) });
    return id;
  }
  async appendEvents(events: Event[]): Promise<number[]> {
    const ids: number[] = [];
    for (const event of events) {
      ids.push(await this.appendEvent(event));
    }
    return ids;
  }
  async getRunEvents(
    runId: string,
    scope: ScopeContext,
    cursor: string | undefined,
    limit: number,
    includeTokens: boolean = true
  ): Promise<EventCursorPage<Event>> {
    const run = await this.requireRun(runId, scope);
    const cursorValue = cursor ? Number.parseInt(cursor, 10) || 0 : 0;
    const rows = this.store.events
      .filter((item) => item.event.run_id === run.id && item.id > cursorValue)
      .filter((item) => includeTokens || item.event.type !== 'llm.token')
      .sort((a, b) => a.id - b.id)
      .slice(0, limit);
    const items = rows.map((item) => clone(item.event));
    const nextCursor = rows.length > 0 ? String(rows[rows.length - 1]?.id ?? '') : null;
    return { items, nextCursor };
  }
}




