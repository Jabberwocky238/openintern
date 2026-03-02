import type { IPostgresPool, IPostgresClient } from '../interfaces/postgres-client.js';
import type { PlanRecord, PlanTaskRecord } from '../../../backend/runtime/models.js';
import type { IPlanRepository } from '../interfaces/plan-repository.js';

interface PlanRow {
  id: string | number;
  run_id: string;
  planner_model: string;
  status: PlanRecord['status'];
  raw_plan: Record<string, unknown>;
  failure_reason: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface TaskRow {
  id: string | number;
  plan_id: string | number;
  run_id: string;
  task_id: string;
  task_text: string;
  role_id: string;
  depends_on: string[] | null;
  layer_index: number;
  status: PlanTaskRecord['status'];
  context: string | null;
  acceptance: string | null;
  child_run_id: string | null;
  tool_call_id: string | null;
  output: string | null;
  error: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface CreatePlanTaskInput {
  taskId: string;
  task: string;
  roleId: string;
  dependsOn: string[];
  layerIndex: number;
  context?: string;
  acceptance?: string;
}

export interface CreatePlanInput {
  runId: string;
  plannerModel: string;
  rawPlan: Record<string, unknown>;
  tasks: CreatePlanTaskInput[];
}

export interface TaskDispatchInput {
  taskId: string;
  childRunId: string;
  toolCallId: string;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNumber(value: string | number): number {
  return typeof value === 'string' ? Number.parseInt(value, 10) : value;
}

function mapPlanRow(row: PlanRow): PlanRecord {
  return {
    id: toNumber(row.id),
    runId: row.run_id,
    plannerModel: row.planner_model,
    status: row.status,
    rawPlan: row.raw_plan,
    failureReason: row.failure_reason,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapTaskRow(row: TaskRow): PlanTaskRecord {
  return {
    id: toNumber(row.id),
    planId: toNumber(row.plan_id),
    runId: row.run_id,
    taskId: row.task_id,
    task: row.task_text,
    roleId: row.role_id,
    dependsOn: row.depends_on ?? [],
    layerIndex: row.layer_index,
    status: row.status,
    context: row.context,
    acceptance: row.acceptance,
    childRunId: row.child_run_id,
    toolCallId: row.tool_call_id,
    output: row.output,
    error: row.error,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export class PlanRepository implements IPlanRepository {
  constructor(private readonly pool: IPostgresPool) {}

  async getPlanByRunId(runId: string): Promise<PlanRecord | null> {
    const result = await this.pool.query<PlanRow>(
      `SELECT * FROM run_task_plans WHERE run_id = $1 LIMIT 1`,
      [runId]
    );
    const row = result.rows[0];
    return row ? mapPlanRow(row) : null;
  }

  async listTasksByRunId(runId: string): Promise<PlanTaskRecord[]> {
    const result = await this.pool.query<TaskRow>(
      `SELECT
        ti.*,
        tp.run_id
      FROM run_task_items ti
      JOIN run_task_plans tp ON tp.id = ti.plan_id
      WHERE tp.run_id = $1
      ORDER BY ti.layer_index ASC, ti.id ASC`,
      [runId]
    );
    return result.rows.map(mapTaskRow);
  }

  async createPlan(input: CreatePlanInput): Promise<{ plan: PlanRecord; tasks: PlanTaskRecord[] }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const planResult = await client.query<PlanRow>(
        `INSERT INTO run_task_plans (run_id, planner_model, status, raw_plan)
        VALUES ($1, $2, 'planned', $3::jsonb)
        RETURNING *`,
        [input.runId, input.plannerModel, JSON.stringify(input.rawPlan)]
      );
      const planRow = planResult.rows[0];
      if (!planRow) throw new Error('Failed to insert run_task_plans row');
      const planId = toNumber(planRow.id);
      if (input.tasks.length === 0) throw new Error('Planner produced empty tasks');

      const values: string[] = [];
      const params: unknown[] = [];
      for (const task of input.tasks) {
        const offset = params.length;
        values.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}::text[], $${offset + 7}, $${offset + 8}, $${offset + 9})`
        );
        params.push(
          planId,
          task.taskId,
          task.task,
          task.roleId,
          task.layerIndex,
          task.dependsOn,
          'planned',
          task.context ?? null,
          task.acceptance ?? null,
        );
      }

      await client.query(
        `INSERT INTO run_task_items (
          plan_id, task_id, task_text, role_id, layer_index, depends_on, status, context, acceptance
        ) VALUES ${values.join(',')}`,
        params
      );

      await client.query('COMMIT');
      const plan = mapPlanRow(planRow);
      const tasks = await this.listTasksByRunId(input.runId);
      return { plan, tasks };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async markPlanStatus(
    runId: string,
    status: PlanRecord['status'],
    failureReason?: string
  ): Promise<void> {
    await this.pool.query(
      `UPDATE run_task_plans
      SET status = $2,
          failure_reason = $3,
          updated_at = NOW()
      WHERE run_id = $1`,
      [runId, status, failureReason ?? null]
    );
  }

  async syncTaskStatusFromDependencies(runId: string): Promise<PlanTaskRecord[]> {
    const result = await this.pool.query<TaskRow>(
      `UPDATE run_task_items ti
      SET status = CASE rd.status WHEN 'completed' THEN 'completed' ELSE 'failed' END,
          output = CASE WHEN rd.status = 'completed'
            THEN COALESCE(rd.result, ti.output)
            ELSE ti.output
          END,
          error = CASE WHEN rd.status = 'failed'
            THEN COALESCE(rd.error, ti.error)
            ELSE ti.error
          END,
          updated_at = NOW()
      FROM run_task_plans tp
      JOIN run_dependencies rd ON rd.parent_run_id = tp.run_id
      WHERE tp.run_id = $1
        AND ti.plan_id = tp.id
        AND ti.child_run_id = rd.child_run_id
        AND ti.status = 'running'
      RETURNING
        ti.*,
        tp.run_id`,
      [runId]
    );
    return result.rows.map(mapTaskRow);
  }

  async listReadyTasksByRunId(runId: string): Promise<PlanTaskRecord[]> {
    const result = await this.pool.query<TaskRow>(
      `SELECT
        ti.*,
        tp.run_id
      FROM run_task_items ti
      JOIN run_task_plans tp ON tp.id = ti.plan_id
      WHERE tp.run_id = $1
        AND ti.status = 'planned'
        AND NOT EXISTS (
          SELECT 1
          FROM unnest(ti.depends_on) AS dep_id
          LEFT JOIN run_task_items dep
            ON dep.plan_id = ti.plan_id
           AND dep.task_id = dep_id
          WHERE dep.status IS DISTINCT FROM 'completed'
        )
      ORDER BY ti.layer_index ASC, ti.id ASC`,
      [runId]
    );
    return result.rows.map(mapTaskRow);
  }

  async markTasksRunning(runId: string, dispatches: TaskDispatchInput[]): Promise<void> {
    if (dispatches.length === 0) return;
    const values: string[] = [];
    const params: unknown[] = [runId];
    for (const dispatch of dispatches) {
      const offset = params.length;
      values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3})`);
      params.push(dispatch.taskId, dispatch.childRunId, dispatch.toolCallId);
    }
    await this.pool.query(
      `UPDATE run_task_items ti
      SET status = 'running',
          child_run_id = data.child_run_id,
          tool_call_id = data.tool_call_id,
          updated_at = NOW()
      FROM run_task_plans tp,
        (VALUES ${values.join(',')}) AS data(task_id, child_run_id, tool_call_id)
      WHERE tp.run_id = $1
        AND ti.plan_id = tp.id
        AND ti.task_id = data.task_id
        AND ti.status = 'planned'`,
      params
    );
  }
}



