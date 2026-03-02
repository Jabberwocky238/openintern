import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../server.js';

function extractWikiToken(url: string): string | null {
  const match = url.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (!match) {
    return null;
  }
  return match[1] ?? null;
}

const DATABASE_URL = process.env['DATABASE_URL'];
const FEISHU_E2E_APP_ID = process.env['FEISHU_E2E_APP_ID'];
const FEISHU_E2E_APP_SECRET = process.env['FEISHU_E2E_APP_SECRET'];
const FEISHU_E2E_DOC_URL = process.env['FEISHU_E2E_DOC_URL'];
const FEISHU_E2E_DOC_TOKEN = FEISHU_E2E_DOC_URL ? extractWikiToken(FEISHU_E2E_DOC_URL) : null;

const describeIfFeishuE2E =
  DATABASE_URL && FEISHU_E2E_APP_ID && FEISHU_E2E_APP_SECRET && FEISHU_E2E_DOC_TOKEN
    ? describe
    : describe.skip;

const HEADERS = {
  'x-org-id': `org_feishu_e2e_${Date.now()}`,
  'x-user-id': 'user_feishu_e2e',
  'x-project-id': `proj_feishu_e2e_${Date.now()}`,
} as const;

describeIfFeishuE2E('Feishu connectors e2e (real API)', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const fn = cleanup.pop();
      if (fn) {
        await fn();
      }
    }
  });

  it('syncs a real wiki/doc page via connector API', async () => {
    const testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'feishu-e2e-'));
    const { app, sseManager, dbReady } = createApp({
      baseDir: testDir,
      databaseUrl: DATABASE_URL!,
      feishu: {
        enabled: true,
        appId: FEISHU_E2E_APP_ID!,
        appSecret: FEISHU_E2E_APP_SECRET!,
        timeoutMs: 20000,
        maxRetries: 3,
      },
    });
    cleanup.push(async () => {
      sseManager.shutdown();
      await fs.promises.rm(testDir, { recursive: true, force: true });
    });
    await dbReady;

    const createRes = await request(app)
      .post('/api/feishu/connectors')
      .set(HEADERS)
      .send({
        name: `e2e-feishu-${Date.now()}`,
        config: {
          folder_tokens: [],
          wiki_node_tokens: [FEISHU_E2E_DOC_TOKEN!],
          file_tokens: [],
          bitable_app_tokens: [],
          poll_interval_seconds: 3600,
          max_docs_per_sync: 10,
          max_records_per_table: 200,
          chunking: {
            target_tokens: 500,
            max_tokens: 1000,
            min_tokens: 120,
            media_context_blocks: 1,
          },
        },
      });

    expect(createRes.status).toBe(201);
    const connector = createRes.body as { id: string };
    expect(connector.id).toMatch(/^fconn_/);

    const syncRes = await request(app)
      .post(`/api/feishu/connectors/${connector.id}/sync`)
      .set(HEADERS)
      .send({ wait: true });

    expect(syncRes.status).toBe(202);
    const job = syncRes.body as {
      id: string;
      status: 'completed' | 'failed' | 'running' | 'pending';
      error_message: string | null;
      stats: {
        processed: number;
        docx_docs: number;
        chunk_count: number;
      };
    };

    expect(job.status).toBe('completed');
    expect(job.error_message).toBeNull();
    expect(job.stats.processed).toBeGreaterThan(0);
    expect(job.stats.docx_docs).toBeGreaterThan(0);
    expect(job.stats.chunk_count).toBeGreaterThan(0);

    const jobsRes = await request(app)
      .get(`/api/feishu/connectors/${connector.id}/jobs?limit=5`)
      .set(HEADERS);
    expect(jobsRes.status).toBe(200);
    const jobsBody = jobsRes.body as { jobs: Array<{ id: string; status: string }> };
    expect(jobsBody.jobs.length).toBeGreaterThan(0);
    expect(jobsBody.jobs[0]?.id).toBe(job.id);
    expect(jobsBody.jobs[0]?.status).toBe('completed');
  }, 120000);
});

