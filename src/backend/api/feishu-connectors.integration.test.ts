import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../server.js';

const describeIfDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

const BASE_HEADERS = {
  'x-org-id': 'org_feishu_test',
  'x-user-id': 'user_feishu_test',
  'x-project-id': 'proj_feishu_test',
} as const;

const CONNECTOR_CONFIG = {
  folder_tokens: ['fld_xxx'],
  wiki_node_tokens: [],
  file_tokens: ['doccn_xxx'],
  bitable_app_tokens: ['bascn_xxx'],
  poll_interval_seconds: 300,
  max_docs_per_sync: 50,
  max_records_per_table: 200,
  chunking: {
    target_tokens: 600,
    max_tokens: 1100,
    min_tokens: 120,
    media_context_blocks: 2,
  },
};

describeIfDatabase('Feishu connectors API', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const fn = cleanup.pop();
      if (fn) {
        await fn();
      }
    }
  });

  it('creates connector and isolates list by org/project', async () => {
    const testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'feishu-api-'));
    const { app, sseManager, dbReady } = createApp({
      baseDir: testDir,
      feishu: { enabled: false },
    });
    cleanup.push(async () => {
      sseManager.shutdown();
      await fs.promises.rm(testDir, { recursive: true, force: true });
    });
    await dbReady;

    const created = await request(app)
      .post('/api/feishu/connectors')
      .set(BASE_HEADERS)
      .send({
        name: `feishu-main-${Date.now()}`,
        config: CONNECTOR_CONFIG,
      });
    const createdBody = created.body as { id: string; status: string };

    expect(created.status).toBe(201);
    expect(createdBody.id).toMatch(/^fconn_/);
    expect(createdBody.status).toBe('active');

    const listSameScope = await request(app)
      .get('/api/feishu/connectors')
      .set(BASE_HEADERS);
    const sameScopeBody = listSameScope.body as { connectors: unknown[] };
    expect(listSameScope.status).toBe(200);
    expect(Array.isArray(sameScopeBody.connectors)).toBe(true);
    expect(sameScopeBody.connectors.length).toBeGreaterThan(0);

    const listOtherProject = await request(app)
      .get('/api/feishu/connectors')
      .set({
        ...BASE_HEADERS,
        'x-project-id': 'proj_other',
      });
    const otherScopeBody = listOtherProject.body as { connectors: unknown[] };
    expect(listOtherProject.status).toBe(200);
    expect(otherScopeBody.connectors).toEqual([]);
  });

  it('requires project_id in request scope', async () => {
    const testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'feishu-api-'));
    const { app, sseManager, dbReady } = createApp({
      baseDir: testDir,
      feishu: { enabled: false },
    });
    cleanup.push(async () => {
      sseManager.shutdown();
      await fs.promises.rm(testDir, { recursive: true, force: true });
    });
    await dbReady;

    const response = await request(app)
      .post('/api/feishu/connectors')
      .set({
        'x-org-id': BASE_HEADERS['x-org-id'],
        'x-user-id': BASE_HEADERS['x-user-id'],
      })
      .send({
        name: 'missing-project',
        config: CONNECTOR_CONFIG,
      });
    const responseBody = response.body as { error: { code: string } };

    expect(response.status).toBe(400);
    expect(responseBody.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns FEISHU_SYNC_DISABLED when sync credentials are not configured', async () => {
    const testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'feishu-api-'));
    const { app, sseManager, dbReady } = createApp({
      baseDir: testDir,
      feishu: { enabled: false },
    });
    cleanup.push(async () => {
      sseManager.shutdown();
      await fs.promises.rm(testDir, { recursive: true, force: true });
    });
    await dbReady;

    const created = await request(app)
      .post('/api/feishu/connectors')
      .set(BASE_HEADERS)
      .send({
        name: `sync-disabled-${Date.now()}`,
        config: CONNECTOR_CONFIG,
      });
    const createdBody = created.body as { id: string };
    expect(created.status).toBe(201);

    const trigger = await request(app)
      .post(`/api/feishu/connectors/${createdBody.id}/sync`)
      .set(BASE_HEADERS)
      .send({ wait: false });
    const triggerBody = trigger.body as { error: { code: string } };

    expect(trigger.status).toBe(400);
    expect(triggerBody.error.code).toBe('FEISHU_SYNC_DISABLED');
  });
});

