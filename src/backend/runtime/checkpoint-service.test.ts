import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type Mock } from 'vitest';
import { createPostgresPool, runPostgresMigrations } from '../db/index.js';
import { generateRunId } from '../../utils/ids.js';
import type { Message } from '../../types/agent.js';
import { CheckpointService } from './checkpoint-service.js';
import { RunRepository, type IRunRepository, type IPostgresPool } from '@openintern/repository';

const describeIfDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

function createUnitFixture(): {
  service: CheckpointService;
  runs: {
    saveCheckpointSnapshot: Mock;
    getLatestCheckpoint: Mock;
    loadMessages: Mock;
  };
} {
  const runs = {
    saveCheckpointSnapshot: vi.fn(async () => undefined),
    getLatestCheckpoint: vi.fn(async () => null),
    loadMessages: vi.fn(async () => []),
  };
  const service = new CheckpointService(runs as unknown as IRunRepository);
  return { service, runs };
}

describe('CheckpointService (unit)', () => {
  it('appends only incremental messages based on lastSavedCount', async () => {
    const { service, runs } = createUnitFixture();
    const messages: Message[] = [
      { role: 'user', content: 'm1' },
      { role: 'assistant', content: 'm2' },
      { role: 'assistant', content: 'm3' },
      { role: 'assistant', content: 'm4' },
      { role: 'tool', content: '{"ok":true}', toolCallId: 'tc_1' },
    ];

    await service.save('run_test', 'main', 'step_0003', messages, 3, { plan: 'single-agent-loop' });

    expect(runs.saveCheckpointSnapshot).toHaveBeenCalledTimes(1);
    const call = runs.saveCheckpointSnapshot.mock.calls[0]?.[0] as {
      messages: Array<{ role: string }>;
      startOrdinal: number;
    };
    expect(call.messages).toHaveLength(2);
    expect(call.messages.map((m) => m.role)).toEqual(['assistant', 'tool']);
    expect(call.startOrdinal).toBe(3);
  });

  it('stores slim checkpoint state without messages field', async () => {
    const { service, runs } = createUnitFixture();
    const messages: Message[] = [{ role: 'user', content: 'hello' }];
    const workingState = {
      budget_state: { utilization: 0.2 },
      messages: [{ role: 'assistant', content: 'should not persist' }],
      nested: { messages: ['drop-me-too'] },
      marker: 'ok',
    };

    await service.save('run_test', 'main', 'step_0007', messages, 0, workingState);

    const call = runs.saveCheckpointSnapshot.mock.calls[0]?.[0] as { state: Record<string, unknown> };
    const persisted = call.state;
    expect(persisted['step_id']).toBe('step_0007');
    expect(persisted['step_number']).toBe(7);
    expect(persisted['message_count']).toBe(1);
    expect(JSON.stringify(persisted)).not.toContain('"messages"');
    expect((persisted['working_state'] as Record<string, unknown>)['marker']).toBe('ok');
  });
});

describeIfDatabase('CheckpointService (integration, Postgres)', () => {
  let pool: IPostgresPool;
  let runs: RunRepository;
  let service: CheckpointService;
  const createdRunIds: string[] = [];

  async function createRun(runId: string): Promise<void> {
    await runs.createRun({
      id: runId,
      scope: {
        orgId: 'org_checkpoint_test',
        userId: 'user_checkpoint_test',
        projectId: null,
      },
      sessionKey: `s_checkpoint_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      input: 'checkpoint test',
      agentId: 'main',
      llmConfig: null,
    });
    createdRunIds.push(runId);
  }

  beforeAll(async () => {
    pool = createPostgresPool();
    await runPostgresMigrations(pool);
    runs = new RunRepository(pool);
    service = new CheckpointService(runs);
  });

  afterEach(async () => {
    if (createdRunIds.length === 0) return;
    const ids = [...createdRunIds];
    createdRunIds.length = 0;
    await pool.query(
      `DELETE FROM run_dependencies
       WHERE parent_run_id = ANY($1::text[]) OR child_run_id = ANY($1::text[])`,
      [ids]
    );
    await pool.query(`DELETE FROM runs WHERE id = ANY($1::text[])`, [ids]);
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('rolls back appended run_messages when checkpoint persistence fails', async () => {
    const runId = generateRunId();
    await createRun(runId);

    const spy = vi
      .spyOn(runs, 'saveCheckpointSnapshot')
      .mockRejectedValueOnce(new Error('simulated checkpoint UPSERT failure'));

    await expect(
      service.save(
        runId,
        'main',
        'step_0001',
        [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'world' },
        ],
        0,
        { plan: 'rollback-check' }
      )
    ).rejects.toThrow('simulated checkpoint UPSERT failure');

    spy.mockRestore();

    const count = await pool.query<{ cnt: string }>(
      'SELECT COUNT(*)::text AS cnt FROM run_messages WHERE run_id = $1',
      [runId]
    );
    expect(Number.parseInt(count.rows[0]?.cnt ?? '0', 10)).toBe(0);
  });

  it('round-trips checkpoint save/load with message order and working_state intact', async () => {
    const runId = generateRunId();
    await createRun(runId);

    const messages: Message[] = [
      { role: 'user', content: 'm0' },
      { role: 'assistant', content: 'm1' },
      { role: 'assistant', content: 'm2', toolCalls: [{ id: 'tc_1', name: 'dispatch_subtasks', parameters: { subtasks: [] } }] },
      { role: 'tool', content: '{"r":1}', toolCallId: 'tc_1' },
      { role: 'assistant', content: 'm4' },
      { role: 'assistant', content: 'm5' },
      { role: 'assistant', content: 'm6' },
      { role: 'assistant', content: 'm7' },
      { role: 'assistant', content: 'm8' },
      { role: 'assistant', content: 'm9' },
    ];
    const workingState = {
      budget_state: {
        total_tokens_used: 1234,
        max_context_tokens: 100000,
        utilization: 0.35,
        compaction_count: 1,
      },
      plan: 'single-agent-loop',
      marker: 'round-trip',
    };

    await service.save(runId, 'main', 'step_0010', messages, 0, workingState);
    const loaded = await service.loadLatest(runId, 'main');

    expect(loaded).not.toBeNull();
    expect(loaded?.stepId).toBe('step_0010');
    expect(loaded?.stepNumber).toBe(10);
    expect(loaded?.messages).toEqual(messages);
    expect(loaded?.workingState).toEqual(workingState);

    const ordinals = await pool.query<{ ordinal: number }>(
      `SELECT ordinal
       FROM run_messages
       WHERE run_id = $1 AND agent_id = $2
       ORDER BY ordinal ASC`,
      [runId, 'main']
    );
    expect(ordinals.rows.map((r) => r.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

