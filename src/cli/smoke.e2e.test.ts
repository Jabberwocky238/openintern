import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type ServerConfig } from '../backend/server.js';
import type { Event } from '@openintern/types/events.js';
import type { RunMeta } from '@openintern/types/run.js';
import { closeSharedPostgresPool } from '../backend/repository/postgres/index.js';

const describeIfDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

const TEST_SCOPE_HEADERS = {
  'x-org-id': 'org_cli_smoke',
  'x-user-id': 'user_cli_smoke',
} as const;

const TEST_SCOPE_ENV = {
  AGENT_ORG_ID: TEST_SCOPE_HEADERS['x-org-id'],
  AGENT_USER_ID: TEST_SCOPE_HEADERS['x-user-id'],
} as const;

interface CliResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

function sessionKey(prefix: string): string {
  return `s_${prefix}_${randomSuffix()}`;
}

function extractRunId(output: string): string {
  const match = output.match(/run_[A-Za-z0-9]+/);
  if (!match) {
    throw new Error(`Could not find run_id in CLI output:\n${output}`);
  }
  return match[0];
}

async function jsonRequest<T>(
  baseUrl: string,
  pathName: string,
  init: RequestInit = {}
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}${pathName}`, init);
  const body = (await response.json()) as T;
  return { status: response.status, body };
}

async function waitForRunStatus(
  baseUrl: string,
  runId: string,
  expected: RunMeta['status'],
  timeoutMs = 15000
): Promise<RunMeta> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await jsonRequest<RunMeta>(baseUrl, `/api/runs/${runId}`, {
      headers: TEST_SCOPE_HEADERS,
    });
    if (res.status === 200 && res.body.status === expected) {
      return res.body;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`Timed out waiting for run ${runId} status ${expected}`);
}

async function listEvents(baseUrl: string, runId: string): Promise<Event[]> {
  const res = await jsonRequest<{ events: Event[] }>(
    baseUrl,
    `/api/runs/${runId}/events?limit=200`,
    { headers: TEST_SCOPE_HEADERS }
  );
  expect(res.status).toBe(200);
  return res.body.events;
}

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 40000
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['cli', ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');

    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 500);
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

async function startTestServer(
  config: Partial<ServerConfig> = {}
): Promise<{
  baseUrl: string;
  appServer: Server;
  sseManager: ReturnType<typeof createApp>['sseManager'];
  testDir: string;
}> {
  const testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cli-smoke-e2e-'));
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
  await closeSharedPostgresPool();
}

describeIfDatabase('CLI smoke e2e', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const fn = cleanup.pop();
      if (fn) {
        await fn();
      }
    }
  });

  it('agent run --wait completes successfully end-to-end', async () => {
    const server = await startTestServer();
    cleanup.push(() => stopTestServer(server.appServer, server.sseManager, server.testDir));

    const result = await runCli(
      [
        'run',
        'cli smoke wait',
        '--session',
        sessionKey('wait'),
        '--wait',
        '--provider',
        'mock',
        '--model',
        'mock-model',
      ],
      {
        AGENT_API_URL: server.baseUrl,
        ...TEST_SCOPE_ENV,
      }
    );

    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    expect(result.stderr.trim()).toBe('');
    expect(result.stdout).toContain('Run ID:');
    expect(result.stdout).toContain('Run completed');

    const runId = extractRunId(result.stdout);
    const run = await waitForRunStatus(server.baseUrl, runId, 'completed');
    expect(run.status).toBe('completed');
  });

  it('agent run --stream outputs terminal events and exits', async () => {
    const server = await startTestServer();
    cleanup.push(() => stopTestServer(server.appServer, server.sseManager, server.testDir));

    const result = await runCli(
      [
        'run',
        'cli smoke stream',
        '--session',
        sessionKey('stream'),
        '--stream',
        '--provider',
        'mock',
        '--model',
        'mock-model',
      ],
      {
        AGENT_API_URL: server.baseUrl,
        ...TEST_SCOPE_ENV,
      }
    );

    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    expect(result.stderr.trim()).toBe('');
    expect(result.stdout).toContain('run.completed');
    expect(result.stdout).toContain('step.completed');

    const runId = extractRunId(result.stdout);
    const events = await listEvents(server.baseUrl, runId);
    expect(events.some((event) => event.type === 'run.started')).toBe(true);
    expect(events.some((event) => event.type === 'run.completed')).toBe(true);
  });
});
