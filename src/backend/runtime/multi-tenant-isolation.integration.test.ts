import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runPostgresMigrations } from '@openintern/repository';
import { createPostgresPool } from '../../packages/repository/postgres/index.js';
import { createEmbeddingProvider } from '../store/embedding-provider.js';
import { MemoryService } from './memory-service.js';
import { createApp, type ServerConfig } from '../server.js';
import type { CreateRunResponse } from '../../types/api.js';
import type { MemoryScope } from '../../types/memory.js';

const describeIfDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

const SCOPE_A_HEADERS = {
  'x-org-id': 'org_tenant_a',
  'x-user-id': 'user_tenant_a',
} as const;

const SCOPE_B_HEADERS = {
  'x-org-id': 'org_tenant_b',
  'x-user-id': 'user_tenant_b',
} as const;

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

function sessionKey(prefix: string): string {
  return `s_${prefix}_${randomSuffix()}`;
}

function requestScope(headers: Record<string, string>): MemoryScope {
  return {
    org_id: headers['x-org-id'] ?? '',
    user_id: headers['x-user-id'] ?? '',
  };
}

async function jsonRequest<T>(
  baseUrl: string,
  input: string,
  init: RequestInit = {}
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}${input}`, init);
  const body = (await response.json()) as T;
  return { status: response.status, body };
}

async function createRun(
  baseUrl: string,
  headers: Record<string, string>,
  input: string,
  session: string
): Promise<CreateRunResponse> {
  const response = await jsonRequest<CreateRunResponse>(baseUrl, '/api/runs', {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      session_key: session,
      input,
    }),
  });

  expect(response.status).toBe(201);
  return response.body;
}

async function startTestServer(
  config: Partial<ServerConfig> = {}
): Promise<{
  baseUrl: string;
  appServer: Server;
  sseManager: ReturnType<typeof createApp>['sseManager'];
  testDir: string;
}> {
  const testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tenant-isolation-int-'));
  const { app, sseManager, dbReady } = createApp({
    baseDir: testDir,
    ...config,
  });
  await dbReady;

  const appServer = createHttpServer(app);
  await new Promise<void>((resolve) => {
    appServer.listen(0, '127.0.0.1', () => resolve());
  });

  const address = appServer.address() as AddressInfo | null;
  if (!address) {
    throw new Error('Server address unavailable');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    appServer,
    sseManager,
    testDir,
  };
}

async function stopTestServer(
  appServer: Server,
  sseManager: ReturnType<typeof createApp>['sseManager'],
  testDir: string
): Promise<void> {
  sseManager.shutdown();
  await new Promise<void>((resolve, reject) => {
    appServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  await fs.promises.rm(testDir, { recursive: true, force: true });
}

describeIfDatabase('Multi-tenant isolation regression (Postgres)', () => {
  const cleanup: Array<() => Promise<void>> = [];
  let memoryService: MemoryService;
  let memoryPool: ReturnType<typeof createPostgresPool>;

  beforeAll(async () => {
    memoryPool = createPostgresPool();
    await runPostgresMigrations(memoryPool);
    memoryService = new MemoryService(
      memoryPool,
      createEmbeddingProvider({
        provider: 'hash',
        dimension: 256,
        alpha: 0.6,
      })
    );
  });

  afterEach(async () => {
    while (cleanup.length > 0) {
      const fn = cleanup.pop();
      if (fn) {
        await fn();
      }
    }
  });

  afterAll(async () => {
    await memoryPool.end();
  });

  it('keeps memory_search and memory_get isolated across scopes', async () => {
    const token = `tenant-memory-${randomSuffix()}`;
    const scopeA = requestScope(SCOPE_A_HEADERS);
    const scopeB = requestScope(SCOPE_B_HEADERS);

    const write = await memoryService.memory_write({
      type: 'episodic',
      scope: scopeA,
      text: `only scope A can read ${token}`,
      metadata: { source: 'tenant-test' },
      importance: 0.9,
    });

    expect(write.id).toMatch(/^[0-9a-f-]{36}$/i);

    const searchA = await memoryService.memory_search({
      query: token,
      scope: scopeA,
      top_k: 8,
    });
    expect(searchA.some((item) => item.id === write.id)).toBe(true);

    const getA = await memoryService.memory_get(write.id, scopeA);
    expect(getA?.id).toBe(write.id);

    const searchB = await memoryService.memory_search({
      query: token,
      scope: scopeB,
      top_k: 8,
    });
    expect(searchB).toEqual([]);

    const getB = await memoryService.memory_get(write.id, scopeB);
    expect(getB).toBeNull();
  });

  it('blocks cross-scope run access (404) while owner scope can access', async () => {
    const server = await startTestServer();
    cleanup.push(() => stopTestServer(server.appServer, server.sseManager, server.testDir));
    const session = sessionKey('tenant');

    const created = await createRun(
      server.baseUrl,
      SCOPE_A_HEADERS,
      `tenant run isolation ${randomSuffix()}`,
      session
    );

    const ownerGet = await jsonRequest<{ run_id: string; status: string }>(
      server.baseUrl,
      `/api/runs/${created.run_id}`,
      { headers: SCOPE_A_HEADERS }
    );
    expect(ownerGet.status).toBe(200);
    expect(ownerGet.body.run_id).toBe(created.run_id);

    const deniedGet = await jsonRequest<{ error: { code: string; message: string } }>(
      server.baseUrl,
      `/api/runs/${created.run_id}`,
      { headers: SCOPE_B_HEADERS }
    );
    expect(deniedGet.status).toBe(404);
    expect(deniedGet.body.error.code).toBe('NOT_FOUND');

    const deniedEvents = await jsonRequest<{ error: { code: string } }>(
      server.baseUrl,
      `/api/runs/${created.run_id}/events`,
      { headers: SCOPE_B_HEADERS }
    );
    expect(deniedEvents.status).toBe(404);
    expect(deniedEvents.body.error.code).toBe('NOT_FOUND');

    const deniedCancel = await jsonRequest<{ error: { code: string } }>(
      server.baseUrl,
      `/api/runs/${created.run_id}/cancel`,
      {
        method: 'POST',
        headers: SCOPE_B_HEADERS,
      }
    );
    expect(deniedCancel.status).toBe(404);
    expect(deniedCancel.body.error.code).toBe('NOT_FOUND');

    const listB = await jsonRequest<{ runs: Array<{ run_id: string }>; total: number }>(
      server.baseUrl,
      `/api/sessions/${encodeURIComponent(session)}/runs`,
      { headers: SCOPE_B_HEADERS }
    );
    expect(listB.status).toBe(200);
    expect(listB.body.total).toBe(0);
    expect(listB.body.runs).toEqual([]);
  });
});

