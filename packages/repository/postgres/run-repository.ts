import type { IPostgresPool, IPostgresClient } from '../interfaces/postgres-client.js';
import type { LLMConfigRequest } from '@openintern/types/api.js';
import type { RunMeta } from '@openintern/types/run.js';
import { NotFoundError } from '@openintern/utils';
import type { Event } from '@openintern/types/events.js';
import type {
  DelegatedPermissions,
  EventCursorPage,
  RunCreateInput,
  RunDependency,
  RunMode,
  RunRecord,
  RunStatus,
} from '../../../src/backend/runtime/models.js';
import { appendScopePredicate, type ScopeContext } from '../shared/scope.js';
import type { IRunRepository } from '../interfaces/run-repository.js';
import { getPostgresPool } from './pool.js';

interface RunRow {
  id: string;
  org_id: string;
  user_id: string;
  project_id: string | null;
  group_id: string | null;
  session_key: string;
  input: string;
  status: RunStatus;
  run_mode: RunMode | null;
  agent_id: string;
  llm_config: LLMConfigRequest | null;
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  parent_run_id: string | null;
  delegated_permissions: DelegatedPermissions | null;
  created_at: string | Date;
  started_at: string | Date | null;
  ended_at: string | Date | null;
  cancelled_at: string | Date | null;
  suspended_at: string | Date | null;
  suspend_reason: string | null;
  event_count?: string;
  tool_count?: string;
}

interface RunDependencyRow {
  id: string | number;
  parent_run_id: string;
  child_run_id: string;
  tool_call_id: string;
  role_id: string | null;
  goal: string;
  status: 'pending' | 'completed' | 'failed';
  result: string | null;
  error: string | null;
  created_at: string | Date;
  completed_at: string | Date | null;
}

function mapDepRow(row: RunDependencyRow): RunDependency {
  return {
    id: typeof row.id === 'string' ? Number.parseInt(row.id, 10) : row.id,
    parentRunId: row.parent_run_id,
    childRunId: row.child_run_id,
    toolCallId: row.tool_call_id,
    roleId: row.role_id,
    goal: row.goal,
    status: row.status,
    result: row.result,
    error: row.error,
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    completedAt: toIso(row.completed_at),
  };
}

interface EventRow {
  id: string | number;
  ts: string | Date;
  agent_id: string;
  group_id: string | null;
  message_type: Event['message_type'] | null;
  step_id: string;
  type: Event['type'];
  payload: Event['payload'];
  v: number;
  span_id: string;
  parent_span_id: string | null;
  redaction: Event['redaction'];
}

function toIso(value: string | Date | null): string | null {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function resolveRunMode(mode: RunMode | null, groupId: string | null): RunMode {
  if (mode) {
    return mode;
  }
  if (groupId) {
    return 'group';
  }
  return 'single';
}

function mapRunRow(row: RunRow): RunRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    userId: row.user_id,
    projectId: row.project_id,
    groupId: row.group_id,
    sessionKey: row.session_key,
    input: row.input,
    status: row.status,
    runMode: resolveRunMode(row.run_mode, row.group_id),
    agentId: row.agent_id,
    llmConfig: row.llm_config,
    result: row.result,
    error: row.error,
    parentRunId: row.parent_run_id ?? null,
    delegatedPermissions: row.delegated_permissions ?? null,
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    startedAt: toIso(row.started_at),
    endedAt: toIso(row.ended_at),
    cancelledAt: toIso(row.cancelled_at),
    suspendedAt: toIso(row.suspended_at),
    suspendReason: row.suspend_reason ?? null,
  };
}

function castBigintCursor(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

type MessageType = NonNullable<Event['message_type']>;

const MESSAGE_TYPE_BY_EVENT_TYPE: Partial<Record<Event['type'], MessageType>> = {
  'message.task': 'TASK',
  'message.proposal': 'PROPOSAL',
  'message.decision': 'DECISION',
  'message.evidence': 'EVIDENCE',
  'message.status': 'STATUS',
};

function resolveMessageType(
  eventType: Event['type'],
  explicit: Event['message_type'] | null | undefined
): MessageType | null {
  return explicit ?? MESSAGE_TYPE_BY_EVENT_TYPE[eventType] ?? null;
}

export class RunRepository implements IRunRepository {
  private readonly pool: IPostgresPool;

  constructor(pool?: IPostgresPool) {
    this.pool = pool ?? getPostgresPool();
  }

  async createRun(input: RunCreateInput): Promise<RunRecord> {
    const runMode = input.runMode ?? (input.groupId ? 'group' : 'single');
    const result = await this.pool.query<RunRow>(
      `INSERT INTO runs (
        id,
        org_id,
        user_id,
        project_id,
        group_id,
        session_key,
        input,
        status,
        run_mode,
        agent_id,
        llm_config,
        parent_run_id,
        delegated_permissions
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10, $11, $12::jsonb)
      RETURNING *`,
      [
        input.id,
        input.scope.orgId,
        input.scope.userId,
        input.scope.projectId,
        input.groupId ?? null,
        input.sessionKey,
        input.input,
        runMode,
        input.agentId,
        input.llmConfig,
        input.parentRunId ?? null,
        input.delegatedPermissions ? JSON.stringify(input.delegatedPermissions) : null,
      ]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('Failed to create run');
    }
    return mapRunRow(row);
  }

  async getRun(runId: string, scope: ScopeContext): Promise<RunRecord | null> {
    const clauses: string[] = ['id = $1'];
    const params: unknown[] = [runId];
    appendScopePredicate(clauses, params, scope);

    const result = await this.pool.query<RunRow>(
      `SELECT * FROM runs WHERE ${clauses.join(' AND ')} LIMIT 1`,
      params
    );
    const row = result.rows[0];
    return row ? mapRunRow(row) : null;
  }

  async requireRun(runId: string, scope: ScopeContext): Promise<RunRecord> {
    const run = await this.getRun(runId, scope);
    if (!run) {
      throw new NotFoundError('Run', runId);
    }
    return run;
  }

  async setRunRunning(runId: string): Promise<void> {
    await this.pool.query(
      `UPDATE runs
      SET status = 'running',
          started_at = COALESCE(started_at, NOW())
      WHERE id = $1
        AND status = 'pending'`,
      [runId]
    );
  }

  async setRunCompleted(runId: string, output: string): Promise<void> {
    await this.pool.query(
      `UPDATE runs
      SET status = 'completed',
          ended_at = NOW(),
          result = $2::jsonb
      WHERE id = $1
        AND status = 'running'`,
      [runId, JSON.stringify({ output })]
    );
  }

  async setRunFailed(runId: string, error: { code: string; message: string }): Promise<void> {
    await this.pool.query(
      `UPDATE runs
      SET status = 'failed',
          ended_at = NOW(),
          error = $2::jsonb
      WHERE id = $1
        AND status = 'running'`,
      [runId, JSON.stringify(error)]
    );
  }

  async setRunCancelled(runId: string): Promise<void> {
    await this.pool.query(
      `UPDATE runs
      SET status = 'cancelled',
          cancelled_at = NOW(),
          ended_at = NOW()
      WHERE id = $1
        AND status IN ('pending', 'running', 'waiting', 'suspended')`,
      [runId]
    );
  }

  async setRunWaiting(runId: string): Promise<void> {
    await this.pool.query(
      `UPDATE runs
      SET status = 'waiting'
      WHERE id = $1
        AND status = 'running'`,
      [runId]
    );
  }

  async setRunResumed(runId: string): Promise<void> {
    await this.pool.query(
      `UPDATE runs
      SET status = 'running'
      WHERE id = $1
        AND status = 'waiting'`,
      [runId]
    );
  }

  async setRunSuspended(runId: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE runs
      SET status = 'suspended',
          suspended_at = NOW(),
          suspend_reason = $2
      WHERE id = $1
        AND status = 'running'`,
      [runId, reason]
    );
  }

  async setRunResumedFromSuspension(runId: string): Promise<void> {
    await this.pool.query(
      `UPDATE runs
      SET status = 'pending',
          suspended_at = NULL,
          suspend_reason = NULL
      WHERE id = $1
        AND status = 'suspended'`,
      [runId]
    );
  }

  async getRunById(runId: string): Promise<RunRecord | null> {
    const result = await this.pool.query<RunRow>(
      `SELECT * FROM runs WHERE id = $1 LIMIT 1`,
      [runId]
    );
    const row = result.rows[0];
    return row ? mapRunRow(row) : null;
  }

  async listRunsBySession(
    scope: ScopeContext,
    sessionKey: string,
    page: number,
    limit: number
  ): Promise<{ runs: RunMeta[]; total: number }> {
    const offset = (page - 1) * limit;
    const predicates: string[] = [
      'session_key = $1',
      'org_id = $2',
      'user_id = $3',
      'project_id IS NOT DISTINCT FROM $4',
    ];
    const countParams: unknown[] = [sessionKey, scope.orgId, scope.userId, scope.projectId];

    const countResult = await this.pool.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM runs WHERE ${predicates.join(' AND ')}`,
      countParams
    );

    const dataParams = [...countParams, limit, offset];
    const runRows = await this.pool.query<RunRow>(
      `SELECT
        r.*,
        COALESCE(stats.event_count, 0)::text AS event_count,
        COALESCE(stats.tool_count, 0)::text AS tool_count
      FROM runs
      AS r
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) AS event_count,
          COUNT(*) FILTER (WHERE type = 'tool.called') AS tool_count
        FROM events e
        WHERE e.run_id = r.id
      ) AS stats ON TRUE
      WHERE r.session_key = $1
        AND r.org_id = $2
        AND r.user_id = $3
        AND r.project_id IS NOT DISTINCT FROM $4
      ORDER BY r.created_at DESC
      LIMIT $${countParams.length + 1}
      OFFSET $${countParams.length + 2}`,
      dataParams
    );

    const runs = runRows.rows.map((row) => this.toRunMeta(row));
    const total = Number.parseInt(countResult.rows[0]?.total ?? '0', 10);
    return { runs, total };
  }

  private toRunMeta(row: RunRow): RunMeta {
    const started = toIso(row.started_at) ?? toIso(row.created_at) ?? new Date().toISOString();
    const ended = toIso(row.ended_at);
    const durationMs =
      ended && started ? new Date(ended).getTime() - new Date(started).getTime() : null;
    return {
      run_id: row.id,
      session_key: row.session_key,
      status: row.status,
      run_mode: resolveRunMode(row.run_mode, row.group_id),
      started_at: started,
      ended_at: ended,
      duration_ms: durationMs,
      event_count: Number.parseInt(row.event_count ?? '0', 10),
      tool_call_count: Number.parseInt(row.tool_count ?? '0', 10),
      parent_run_id: row.parent_run_id ?? null,
    };
  }

  /**
   * Fetch completed prior runs in a session for conversation history reconstruction.
   * Returns only the fields needed (id, input, result) ordered oldest-first.
   */
  async listSessionHistory(
    scope: ScopeContext,
    sessionKey: string,
    limit: number
  ): Promise<Array<{ id: string; input: string; result: string | null }>> {
    const result = await this.pool.query<{
      id: string;
      input: string;
      result: Record<string, unknown> | null;
    }>(
      `SELECT id, input, result
      FROM runs
      WHERE session_key = $1
        AND org_id = $2
        AND user_id = $3
        AND project_id IS NOT DISTINCT FROM $4
        AND status = 'completed'
        AND parent_run_id IS NULL
      ORDER BY created_at DESC
      LIMIT $5`,
      [sessionKey, scope.orgId, scope.userId, scope.projectId, limit]
    );

    return result.rows.reverse().map((row) => ({
      id: row.id,
      input: row.input,
      result: row.result && typeof row.result === 'object' && 'output' in row.result
        ? String(row.result.output)
        : null,
    }));
  }

  async getChildRuns(parentRunId: string): Promise<RunMeta[]> {
    const result = await this.pool.query<RunRow>(
      `SELECT
        r.*,
        COALESCE(stats.event_count, 0)::text AS event_count,
        COALESCE(stats.tool_count, 0)::text AS tool_count
      FROM runs AS r
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) AS event_count,
          COUNT(*) FILTER (WHERE type = 'tool.called') AS tool_count
        FROM events e
        WHERE e.run_id = r.id
      ) AS stats ON TRUE
      WHERE r.parent_run_id = $1
      ORDER BY r.created_at ASC`,
      [parentRunId]
    );
    return result.rows.map((row) => this.toRunMeta(row));
  }

  async appendEvent(event: Event): Promise<number> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO events (
        run_id,
        ts,
        agent_id,
        group_id,
        message_type,
        step_id,
        type,
        payload,
        v,
        span_id,
        parent_span_id,
        redaction
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12::jsonb)
      RETURNING id::text AS id`,
      [
        event.run_id,
        event.ts,
        event.agent_id,
        event.group_id ?? null,
        resolveMessageType(event.type, event.message_type),
        event.step_id,
        event.type,
        JSON.stringify(event.payload),
        event.v,
        event.span_id,
        event.parent_span_id,
        JSON.stringify(event.redaction),
      ]
    );
    return Number.parseInt(result.rows[0]?.id ?? '0', 10);
  }

  async appendEvents(events: Event[]): Promise<number[]> {
    if (events.length === 0) {
      return [];
    }

    const values: string[] = [];
    const params: unknown[] = [];
    for (const event of events) {
      const offset = params.length;
      values.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}::jsonb, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}::jsonb)`
      );
      params.push(
        event.run_id,
        event.ts,
        event.agent_id,
        event.group_id ?? null,
        resolveMessageType(event.type, event.message_type),
        event.step_id,
        event.type,
        JSON.stringify(event.payload),
        event.v,
        event.span_id,
        event.parent_span_id,
        JSON.stringify(event.redaction)
      );
    }

    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO events (
        run_id,
        ts,
        agent_id,
        group_id,
        message_type,
        step_id,
        type,
        payload,
        v,
        span_id,
        parent_span_id,
        redaction
      ) VALUES ${values.join(',')}
      RETURNING id::text AS id`,
      params
    );

    return result.rows.map((row) => Number.parseInt(row.id, 10));
  }

  async getRunEvents(
    runId: string,
    scope: ScopeContext,
    cursor: string | undefined,
    limit: number,
    includeTokens: boolean = true
  ): Promise<EventCursorPage<Event>> {
    const run = await this.requireRun(runId, scope);
    const cursorValue = cursor ? castBigintCursor(cursor) : 0;
    const tokenPredicate = includeTokens ? '' : `AND type <> 'llm.token'`;
    const result = await this.pool.query<EventRow>(
      `SELECT
        id,
        ts,
        agent_id,
        group_id,
        message_type,
        step_id,
        type,
        payload,
        v,
        span_id,
        parent_span_id,
        redaction
      FROM events
      WHERE run_id = $1
        AND id > $2
        ${tokenPredicate}
      ORDER BY id ASC
      LIMIT $3`,
      [run.id, cursorValue, limit]
    );

    const items = result.rows.map((row) => {
      const messageType = resolveMessageType(row.type, row.message_type);
      return {
        v: row.v === 1 ? 1 : 1,
        ts: toIso(row.ts) ?? new Date().toISOString(),
        session_key: run.sessionKey,
        run_id: run.id,
        agent_id: row.agent_id,
        ...(row.group_id ? { group_id: row.group_id } : {}),
        ...(messageType ? { message_type: messageType } : {}),
        step_id: row.step_id,
        span_id: row.span_id,
        parent_span_id: row.parent_span_id,
        type: row.type,
        payload: row.payload,
        redaction: row.redaction,
      };
    }) as Event[];
    const nextCursorRow = result.rows[result.rows.length - 1];
    const nextCursor = nextCursorRow ? String(nextCursorRow.id) : null;
    return { items, nextCursor };
  }

  async createCheckpoint(
    runId: string,
    agentId: string,
    stepId: string,
    state: Record<string, unknown>,
    client?: IPostgresClient
  ): Promise<void> {
    const db = client ?? this.pool;
    await db.query(
      `INSERT INTO checkpoints (run_id, agent_id, step_id, state)
      VALUES ($1, $2, $3, $4::jsonb)`,
      [runId, agentId, stepId, JSON.stringify(state)]
    );
  }

  async getLatestCheckpoint(
    runId: string,
    agentId: string
  ): Promise<{ stepId: string; state: Record<string, unknown> } | null> {
    const result = await this.pool.query<{
      step_id: string;
      state: Record<string, unknown>;
    }>(
      `SELECT step_id, state
      FROM checkpoints
      WHERE run_id = $1
        AND agent_id = $2
      ORDER BY id DESC
      LIMIT 1`,
      [runId, agentId]
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return { stepId: row.step_id, state: row.state };
  }

  async cancelPendingRun(
    runId: string,
    scope: ScopeContext,
    client?: IPostgresClient
  ): Promise<boolean> {
    const db = client ?? this.pool;
    const clauses: string[] = ['id = $1', `status = 'pending'`];
    const params: unknown[] = [runId];
    appendScopePredicate(clauses, params, scope);

    const result = await db.query<{ id: string }>(
      `UPDATE runs
      SET status = 'cancelled',
          cancelled_at = NOW(),
          ended_at = NOW()
      WHERE ${clauses.join(' AND ')}
      RETURNING id`,
      params
    );
    return (result.rowCount ?? 0) > 0;
  }

  async appendMessages(
    runId: string,
    agentId: string,
    stepId: string,
    messages: Array<{ role: string; content: unknown; toolCallId?: string; toolCalls?: unknown }>,
    startOrdinal: number,
    client?: IPostgresClient
  ): Promise<void> {
    if (messages.length === 0) return;
    const db = client ?? this.pool;
    const values: string[] = [];
    const params: unknown[] = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]!;
      const off = params.length;
      values.push(
        `($${off + 1}, $${off + 2}, $${off + 3}, $${off + 4}, $${off + 5}, $${off + 6}::jsonb, $${off + 7}, $${off + 8}::jsonb)`
      );
      params.push(
        runId,
        agentId,
        stepId,
        startOrdinal + i,
        m.role,
        JSON.stringify(m.content),
        m.toolCallId ?? null,
        m.toolCalls ? JSON.stringify(m.toolCalls) : null
      );
    }
    await db.query(
      `INSERT INTO run_messages (run_id, agent_id, step_id, ordinal, role, content, tool_call_id, tool_calls)
      VALUES ${values.join(',')}`,
      params
    );
  }

  async saveCheckpointSnapshot(input: {
    runId: string;
    agentId: string;
    stepId: string;
    messages: Array<{ role: string; content: unknown; toolCallId?: string; toolCalls?: unknown }>;
    startOrdinal: number;
    state: Record<string, unknown>;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (input.messages.length > 0) {
        await this.appendMessages(
          input.runId,
          input.agentId,
          input.stepId,
          input.messages,
          input.startOrdinal,
          client
        );
      }
      await this.createCheckpoint(
        input.runId,
        input.agentId,
        input.stepId,
        input.state,
        client
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async loadMessages(
    runId: string,
    agentId: string
  ): Promise<Array<{ role: string; content: unknown; toolCallId?: string; toolCalls?: unknown }>> {
    const result = await this.pool.query<{
      role: string;
      content: unknown;
      tool_call_id: string | null;
      tool_calls: Record<string, unknown> | null;
    }>(
      `SELECT role, content, tool_call_id, tool_calls
      FROM run_messages
      WHERE run_id = $1 AND agent_id = $2
      ORDER BY ordinal ASC`,
      [runId, agentId]
    );
    return result.rows.map((row) => ({
      role: row.role,
      content: row.content,
      ...(row.tool_call_id ? { toolCallId: row.tool_call_id } : {}),
      ...(row.tool_calls ? { toolCalls: row.tool_calls } : {}),
    }));
  }

  async countEventsAndTools(runId: string): Promise<{ eventCount: number; toolCalls: number }> {
    const result = await this.pool.query<{
      event_count: string;
      tool_count: string;
    }>(
      `SELECT
        COUNT(*)::text AS event_count,
        COUNT(*) FILTER (WHERE type = 'tool.called')::text AS tool_count
      FROM events
      WHERE run_id = $1`,
      [runId]
    );
    const row = result.rows[0];
    return {
      eventCount: Number.parseInt(row?.event_count ?? '0', 10),
      toolCalls: Number.parseInt(row?.tool_count ?? '0', 10),
    };
  }

  // ─── Run Dependencies ───────────────────────────────────

  async createDependency(
    parentRunId: string,
    childRunId: string,
    toolCallId: string,
    roleId: string | null,
    goal: string
  ): Promise<RunDependency> {
    const result = await this.pool.query<RunDependencyRow>(
      `INSERT INTO run_dependencies (parent_run_id, child_run_id, tool_call_id, role_id, goal)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *`,
      [parentRunId, childRunId, toolCallId, roleId, goal]
    );
    const row = result.rows[0];
    if (!row) throw new Error('Failed to create run dependency');
    return mapDepRow(row);
  }

  /**
   * Atomically complete a dependency and return the count of remaining pending
   * siblings. Uses SELECT FOR UPDATE to prevent race conditions on fan-in.
   */
  async completeDependencyAtomic(
    childRunId: string,
    status: 'completed' | 'failed',
    result?: string,
    error?: string
  ): Promise<{ dep: RunDependency; pendingCount: number } | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Lock all sibling rows for this parent
      const depResult = await client.query<RunDependencyRow>(
        `SELECT * FROM run_dependencies WHERE child_run_id = $1 LIMIT 1`,
        [childRunId]
      );
      const depRow = depResult.rows[0];
      if (!depRow) {
        await client.query('ROLLBACK');
        return null;
      }

      // Lock all siblings for this parent to prevent concurrent fan-in
      await client.query(
        `SELECT id FROM run_dependencies WHERE parent_run_id = $1 FOR UPDATE`,
        [depRow.parent_run_id]
      );

      // Update this dependency
      const updated = await client.query<RunDependencyRow>(
        `UPDATE run_dependencies
        SET status = $2, result = $3, error = $4, completed_at = NOW()
        WHERE child_run_id = $1
          AND status = 'pending'
        RETURNING *`,
        [childRunId, status, result ?? null, error ?? null]
      );

      const updatedRow = updated.rows[0];
      if (!updatedRow) {
        await client.query('COMMIT');
        return null;
      }

      // Count remaining pending
      const countResult = await client.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM run_dependencies
        WHERE parent_run_id = $1 AND status = 'pending'`,
        [depRow.parent_run_id]
      );

      await client.query('COMMIT');

      return {
        dep: mapDepRow(updatedRow),
        pendingCount: Number.parseInt(countResult.rows[0]?.cnt ?? '0', 10),
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listDependenciesByParent(parentRunId: string): Promise<RunDependency[]> {
    const result = await this.pool.query<RunDependencyRow>(
      `SELECT * FROM run_dependencies WHERE parent_run_id = $1 ORDER BY id ASC`,
      [parentRunId]
    );
    return result.rows.map(mapDepRow);
  }

  async getDependencyByChild(childRunId: string): Promise<RunDependency | null> {
    const result = await this.pool.query<RunDependencyRow>(
      `SELECT * FROM run_dependencies WHERE child_run_id = $1 LIMIT 1`,
      [childRunId]
    );
    const row = result.rows[0];
    return row ? mapDepRow(row) : null;
  }
}






