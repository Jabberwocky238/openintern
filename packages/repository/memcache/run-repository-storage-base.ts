import type { Event } from '@openintern/types/events.js';
import type { RunDependency } from '../../runtime/models.js';
import type { ScopeContext } from '../shared/scope.js';
import type { RunMessageRecord } from '../interfaces/run-repository.js';
import type { IPostgresClient } from '../interfaces/postgres-client.js';
import { clone, matchesScope, nowIso } from './helpers.js';
import { type MemoryRepositoryStore } from './store.js';

export abstract class RunRepositoryStorageBase {
  constructor(protected readonly store: MemoryRepositoryStore) {}

  async createCheckpoint(
    runId: string,
    agentId: string,
    stepId: string,
    state: Record<string, unknown>,
    _client?: IPostgresClient
  ): Promise<void> {
    this.store.checkpoints.push({
      id: this.store.nextCheckpointId++,
      runId,
      agentId,
      stepId,
      state: clone(state),
    });
  }

  async getLatestCheckpoint(runId: string, agentId: string): Promise<{ stepId: string; state: Record<string, unknown> } | null> {
    const row = [...this.store.checkpoints]
      .filter((item) => item.runId === runId && item.agentId === agentId)
      .sort((a, b) => b.id - a.id)[0];
    return row ? { stepId: row.stepId, state: clone(row.state) } : null;
  }

  async cancelPendingRun(runId: string, scope: ScopeContext, _client?: IPostgresClient): Promise<boolean> {
    const run = this.store.runs.get(runId);
    if (!run || run.status !== 'pending' || !matchesScope(scope, run)) {
      return false;
    }
    const now = nowIso();
    this.store.runs.set(runId, { ...run, status: 'cancelled', cancelledAt: now, endedAt: now });
    return true;
  }

  async appendMessages(
    runId: string,
    agentId: string,
    stepId: string,
    messages: RunMessageRecord[],
    startOrdinal: number,
    _client?: IPostgresClient
  ): Promise<void> {
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (!message) {
        continue;
      }
      this.store.runMessages.push({
        runId,
        agentId,
        stepId,
        ordinal: startOrdinal + index,
        message: clone(message),
      });
    }
  }

  async saveCheckpointSnapshot(input: {
    runId: string;
    agentId: string;
    stepId: string;
    messages: RunMessageRecord[];
    startOrdinal: number;
    state: Record<string, unknown>;
  }): Promise<void> {
    await this.appendMessages(
      input.runId,
      input.agentId,
      input.stepId,
      input.messages,
      input.startOrdinal
    );
    await this.createCheckpoint(
      input.runId,
      input.agentId,
      input.stepId,
      input.state
    );
  }

  async loadMessages(runId: string, agentId: string): Promise<RunMessageRecord[]> {
    return this.store.runMessages
      .filter((row) => row.runId === runId && row.agentId === agentId)
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((row) => clone(row.message));
  }

  async countEventsAndTools(runId: string): Promise<{ eventCount: number; toolCalls: number }> {
    const events = this.eventsForRun(runId);
    return {
      eventCount: events.length,
      toolCalls: events.filter((event) => event.type === 'tool.called').length,
    };
  }

  async createDependency(
    parentRunId: string,
    childRunId: string,
    toolCallId: string,
    roleId: string | null,
    goal: string
  ): Promise<RunDependency> {
    const dep: RunDependency = {
      id: this.store.nextDependencyId++,
      parentRunId,
      childRunId,
      toolCallId,
      roleId,
      goal,
      status: 'pending',
      result: null,
      error: null,
      createdAt: nowIso(),
      completedAt: null,
    };
    this.store.runDependencies.push(clone(dep));
    return dep;
  }

  async completeDependencyAtomic(
    childRunId: string,
    status: 'completed' | 'failed',
    result?: string,
    error?: string
  ): Promise<{ dep: RunDependency; pendingCount: number } | null> {
    const index = this.store.runDependencies.findIndex((dep) => dep.childRunId === childRunId);
    if (index < 0) {
      return null;
    }
    const current = this.store.runDependencies[index];
    if (!current || current.status !== 'pending') {
      return null;
    }
    const next: RunDependency = {
      ...current,
      status,
      result: result ?? null,
      error: error ?? null,
      completedAt: nowIso(),
    };
    this.store.runDependencies[index] = next;
    const pendingCount = this.store.runDependencies.filter(
      (dep) => dep.parentRunId === next.parentRunId && dep.status === 'pending'
    ).length;
    return { dep: clone(next), pendingCount };
  }

  async listDependenciesByParent(parentRunId: string): Promise<RunDependency[]> {
    return this.store.runDependencies
      .filter((dep) => dep.parentRunId === parentRunId)
      .sort((a, b) => a.id - b.id)
      .map((dep) => clone(dep));
  }

  async getDependencyByChild(childRunId: string): Promise<RunDependency | null> {
    const dep = this.store.runDependencies.find((item) => item.childRunId === childRunId);
    return dep ? clone(dep) : null;
  }

  protected eventsForRun(runId: string): Event[] {
    return this.store.events.filter((row) => row.event.run_id === runId).map((row) => row.event);
  }
}



