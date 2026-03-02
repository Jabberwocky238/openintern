import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer as createHttpServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type ServerConfig } from '../server.js';
import type { Event } from '../../types/events.js';
import type { CreateRunResponse, GetRunEventsResponse } from '../../types/api.js';
import type { RunMeta } from '../../types/run.js';
import type { RunExecutor } from '../queue/run-queue.js';

const describeIfDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

const TEST_SCOPE_HEADERS = {
  'x-org-id': 'org_runtime_test',
  'x-user-id': 'user_runtime_test',
} as const;

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

function sessionKey(prefix: string): string {
  return `s_${prefix}_${randomSuffix()}`;
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
  input: string,
  key: string
): Promise<CreateRunResponse> {
  const response = await jsonRequest<CreateRunResponse>(
    baseUrl,
    '/api/runs',
    {
      method: 'POST',
      headers: {
        ...TEST_SCOPE_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        session_key: key,
        input,
      }),
    }
  );
  expect(response.status).toBe(201);
  expect(response.body.run_id).toMatch(/^run_/);
  return response.body;
}

async function waitForRunStatus(
  baseUrl: string,
  runId: string,
  expected: Array<RunMeta['status']>,
  timeoutMs = 15000
): Promise<RunMeta> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await jsonRequest<RunMeta>(baseUrl, `/api/runs/${runId}`, {
      headers: TEST_SCOPE_HEADERS,
    });
    if (res.status === 200 && expected.includes(res.body.status)) {
      return res.body;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`Timed out waiting run ${runId} status in ${expected.join(',')}`);
}

async function collectSSEUntilTerminal(
  baseUrl: string,
  runId: string,
  timeoutMs = 15000
): Promise<Event[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const events: Event[] = [];

  try {
    const response = await fetch(`${baseUrl}/api/runs/${runId}/stream?cursor=0`, {
      headers: TEST_SCOPE_HEADERS,
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.body).not.toBeNull();
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) {
          continue;
        }
        const payload = line.slice(6);
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }
        if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
          continue;
        }
        const event = parsed as Event;
        events.push(event);
        if (event.type === 'run.completed' || event.type === 'run.failed') {
          await reader.cancel();
          return events;
        }
      }
    }

    return events;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Timed out waiting terminal SSE event for run ${runId}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function startTestServer(
  config: Partial<ServerConfig> = {},
  customExecutor?: RunExecutor
): Promise<{
  baseUrl: string;
  appServer: Server;
  sseManager: ReturnType<typeof createApp>['sseManager'];
  testDir: string;
}> {
  const testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'runs-runtime-int-'));
  const { app, runQueue, sseManager, dbReady } = createApp({
    baseDir: testDir,
    ...config,
  });
  await dbReady;

  if (customExecutor) {
    runQueue.setExecutor(customExecutor);
  }

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

describeIfDatabase('Runs runtime integration (Postgres)', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const fn = cleanup.pop();
      if (fn) {
        await fn();
      }
    }
  });

  it('streams SSE events and reaches run.completed', async () => {
    const server = await startTestServer();
    cleanup.push(() => stopTestServer(server.appServer, server.sseManager, server.testDir));

    const run = await createRun(server.baseUrl, 'say hello', sessionKey('sse'));
    const events = await collectSSEUntilTerminal(server.baseUrl, run.run_id);

    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'run.started',
        'step.started',
        'llm.called',
        'step.completed',
        'run.completed',
      ])
    );
    expect(events.at(-1)?.type).toBe('run.completed');

    const runMeta = await waitForRunStatus(server.baseUrl, run.run_id, ['completed']);
    expect(runMeta.status).toBe('completed');
  });

  it('emits run.completed with fallback output when maxSteps is 0', async () => {
    const server = await startTestServer({ maxSteps: 0 });
    cleanup.push(() => stopTestServer(server.appServer, server.sseManager, server.testDir));

    const run = await createRun(server.baseUrl, 'force fail', sessionKey('fail'));
    const events = await collectSSEUntilTerminal(server.baseUrl, run.run_id);
    const terminal = events.at(-1);

    expect(terminal?.type).toBe('run.completed');
    if (terminal?.type === 'run.completed') {
      expect(terminal.payload.output).toContain('maximum number of tool call iterations (0)');
    }

    const runMeta = await waitForRunStatus(server.baseUrl, run.run_id, ['completed']);
    expect(runMeta.status).toBe('completed');
  });

  it('cancels a pending run while another run occupies the worker', async () => {
    const server = await startTestServer(
      {},
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    );
    cleanup.push(() => stopTestServer(server.appServer, server.sseManager, server.testDir));

    const blockingRun = await createRun(server.baseUrl, 'run one', sessionKey('cancel'));
    const pendingRun = await createRun(server.baseUrl, 'run two', sessionKey('cancel'));
    expect(blockingRun.run_id).not.toBe(pendingRun.run_id);

    const cancelRes = await jsonRequest<{ success: boolean; run_id: string }>(
      server.baseUrl,
      `/api/runs/${pendingRun.run_id}/cancel`,
      {
        method: 'POST',
        headers: TEST_SCOPE_HEADERS,
      }
    );
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.success).toBe(true);
    expect(cancelRes.body.run_id).toBe(pendingRun.run_id);

    const cancelled = await waitForRunStatus(server.baseUrl, pendingRun.run_id, ['cancelled']);
    expect(cancelled.status).toBe('cancelled');
  });

  it('supports events pagination with next_cursor', async () => {
    const server = await startTestServer();
    cleanup.push(() => stopTestServer(server.appServer, server.sseManager, server.testDir));

    const run = await createRun(server.baseUrl, 'paginate events', sessionKey('page'));
    await waitForRunStatus(server.baseUrl, run.run_id, ['completed']);

    const firstPage = await jsonRequest<GetRunEventsResponse>(
      server.baseUrl,
      `/api/runs/${run.run_id}/events?limit=2`,
      {
        headers: TEST_SCOPE_HEADERS,
      }
    );
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.events.length).toBeLessThanOrEqual(2);
    expect(firstPage.body.next_cursor).toBeTruthy();

    const secondPage = await jsonRequest<GetRunEventsResponse>(
      server.baseUrl,
      `/api/runs/${run.run_id}/events?cursor=${firstPage.body.next_cursor}&limit=50`,
      {
        headers: TEST_SCOPE_HEADERS,
      }
    );
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.events.length).toBeGreaterThan(0);

    const firstIds = new Set(firstPage.body.events.map((event) => event.span_id));
    const secondIds = new Set(secondPage.body.events.map((event) => event.span_id));
    for (const id of firstIds) {
      expect(secondIds.has(id)).toBe(false);
    }
    expect(
      [...firstPage.body.events, ...secondPage.body.events].some(
        (event) => event.type === 'run.completed'
      )
    ).toBe(true);
  });

  it('does not persist llm.token events by default', async () => {
    const server = await startTestServer();
    cleanup.push(() => stopTestServer(server.appServer, server.sseManager, server.testDir));

    const run = await createRun(server.baseUrl, 'token persistence off', sessionKey('token_off'));
    await waitForRunStatus(server.baseUrl, run.run_id, ['completed']);

    const eventsResponse = await jsonRequest<GetRunEventsResponse>(
      server.baseUrl,
      `/api/runs/${run.run_id}/events?limit=1000&include_tokens=true`,
      {
        headers: TEST_SCOPE_HEADERS,
      }
    );
    expect(eventsResponse.status).toBe(200);
    expect(eventsResponse.body.events.some((event) => event.type === 'llm.token')).toBe(false);
  });

  it('persists llm.token events when persistLlmTokens is enabled', async () => {
    const server = await startTestServer({ persistLlmTokens: true });
    cleanup.push(() => stopTestServer(server.appServer, server.sseManager, server.testDir));

    const run = await createRun(server.baseUrl, 'token persistence on', sessionKey('token_on'));
    await waitForRunStatus(server.baseUrl, run.run_id, ['completed']);

    const withTokens = await jsonRequest<GetRunEventsResponse>(
      server.baseUrl,
      `/api/runs/${run.run_id}/events?limit=1000&include_tokens=true`,
      {
        headers: TEST_SCOPE_HEADERS,
      }
    );
    expect(withTokens.status).toBe(200);
    expect(withTokens.body.events.some((event) => event.type === 'llm.token')).toBe(true);

    const withoutTokens = await jsonRequest<GetRunEventsResponse>(
      server.baseUrl,
      `/api/runs/${run.run_id}/events?limit=1000&include_tokens=false`,
      {
        headers: TEST_SCOPE_HEADERS,
      }
    );
    expect(withoutTokens.status).toBe(200);
    expect(withoutTokens.body.events.some((event) => event.type === 'llm.token')).toBe(false);
  });
});
