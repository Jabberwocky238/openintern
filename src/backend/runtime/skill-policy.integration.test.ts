/**
 * Phase 2 Integration Tests - Skills API + Tool Policy enforcement
 *
 * Tests:
 * 1. Skills API CRUD lifecycle via HTTP endpoints (requires DATABASE_URL)
 * 2. ToolPolicy + SkillRegistry + RuntimeToolRouter integration (in-memory)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { createApp, type ServerConfig } from '../server.js';
import { RuntimeToolRouter } from './tool-router.js';
import { SkillRegistry } from './skill/registry.js';
import { ToolPolicy } from './tool-policy.js';
import type { AgentContext } from './tool-policy.js';
import type { MemoryService } from './memory-service.js';
import type { EventService } from './event-service.js';
import type { Skill } from '../../types/skill.js';

const describeIfDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

// ── HTTP helpers ──

async function jsonRequest<T>(
  baseUrl: string,
  input: string,
  init: RequestInit = {}
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}${input}`, init);
  const body = (await response.json()) as T;
  return { status: response.status, body };
}

async function startTestServer(
  config: Partial<ServerConfig> = {}
): Promise<{
  baseUrl: string;
  appServer: Server;
  sseManager: ReturnType<typeof createApp>['sseManager'];
  testDir: string;
}> {
  const testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'skill-policy-int-'));
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
  if (!address) throw new Error('Server address unavailable');

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
    appServer.close((err) => (err ? reject(err) : resolve()));
  });
  await fs.promises.rm(testDir, { recursive: true, force: true });
}

// ── Section 1: Skills API CRUD (requires Postgres) ──

describeIfDatabase('Skills API CRUD (Postgres)', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const fn = cleanup.pop();
      if (fn) await fn();
    }
  });

  it('creates a skill and retrieves it by id', async () => {
    const server = await startTestServer();
    cleanup.push(() => stopTestServer(server.appServer, server.sseManager, server.testDir));

    const createRes = await jsonRequest<Skill>(server.baseUrl, '/api/skills', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'File Tools',
        description: 'File system operations',
        tools: [
          { name: 'read_file', description: 'Read a file', parameters: {} },
          { name: 'write_file', description: 'Write a file', parameters: {} },
        ],
        risk_level: 'medium',
        provider: 'builtin',
      }),
    });

    expect(createRes.status).toBe(201);
    expect(createRes.body.id).toMatch(/^skill_/);
    expect(createRes.body.name).toBe('File Tools');
    expect(createRes.body.tools).toHaveLength(2);
    expect(createRes.body.risk_level).toBe('medium');

    const getRes = await jsonRequest<Skill>(
      server.baseUrl,
      `/api/skills/${createRes.body.id}`
    );
    expect(getRes.status).toBe(200);
    expect(getRes.body.id).toBe(createRes.body.id);
    expect(getRes.body.name).toBe('File Tools');
  });

  it('lists all skills', async () => {
    const server = await startTestServer();
    cleanup.push(() => stopTestServer(server.appServer, server.sseManager, server.testDir));

    await jsonRequest(server.baseUrl, '/api/skills', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Skill A' }),
    });
    await jsonRequest(server.baseUrl, '/api/skills', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Skill B' }),
    });

    const listRes = await jsonRequest<{ skills: Skill[] }>(
      server.baseUrl,
      '/api/skills'
    );
    expect(listRes.status).toBe(200);
    expect(listRes.body.skills.length).toBeGreaterThanOrEqual(2);
  });

  it('deletes a skill and returns 404 on re-fetch', async () => {
    const server = await startTestServer();
    cleanup.push(() => stopTestServer(server.appServer, server.sseManager, server.testDir));

    const created = await jsonRequest<Skill>(server.baseUrl, '/api/skills', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ephemeral Skill' }),
    });
    expect(created.status).toBe(201);

    const delRes = await fetch(
      `${server.baseUrl}/api/skills/${created.body.id}`,
      { method: 'DELETE' }
    );
    expect(delRes.status).toBe(204);

    const getRes = await jsonRequest<{ error: { code: string } }>(
      server.baseUrl,
      `/api/skills/${created.body.id}`
    );
    expect(getRes.status).toBe(404);
    expect(getRes.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 400 for invalid skill creation payload', async () => {
    const server = await startTestServer();
    cleanup.push(() => stopTestServer(server.appServer, server.sseManager, server.testDir));

    const res = await jsonRequest<{ error: { code: string } }>(
      server.baseUrl,
      '/api/skills',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '' }),
      }
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when deleting non-existent skill', async () => {
    const server = await startTestServer();
    cleanup.push(() => stopTestServer(server.appServer, server.sseManager, server.testDir));

    const res = await jsonRequest<{ error: { code: string } }>(
      server.baseUrl,
      '/api/skills/skill_nonexistent',
      { method: 'DELETE' }
    );
    expect(res.status).toBe(404);
  });
});

// ── Section 2: ToolPolicy + SkillRegistry + RuntimeToolRouter (in-memory) ──

interface MockMemoryService {
  memory_search: Mock;
  memory_get: Mock;
  memory_write: Mock;
}

interface MockEventService {
  list: Mock;
}

describe('ToolPolicy �?SkillRegistry �?RuntimeToolRouter integration', () => {
  let workDir: string;
  let memoryService: MockMemoryService;
  let eventService: MockEventService;

  beforeEach(async () => {
    workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'policy-int-'));
    memoryService = {
      memory_search: vi.fn().mockResolvedValue([]),
      memory_get: vi.fn().mockResolvedValue(null),
      memory_write: vi.fn().mockResolvedValue({ id: 'mem_1' }),
    };
    eventService = {
      list: vi.fn().mockResolvedValue({ events: [], next_cursor: null }),
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.promises.rm(workDir, { recursive: true, force: true });
  });

  function createRouterWithSkills(
    skills: Array<{ name: string; tools: string[]; risk_level: 'low' | 'medium' | 'high' }>
  ): RuntimeToolRouter {
    const registry = new SkillRegistry();
    for (const skill of skills) {
      registry.register({
        id: `skill_${skill.name}`,
        name: skill.name,
        description: '',
        tools: skill.tools.map((t) => ({ name: t, description: '', parameters: {} })),
        risk_level: skill.risk_level,
        provider: 'builtin',
        health_status: 'healthy',
        allow_implicit_invocation: false,
      });
    }
    return new RuntimeToolRouter({
      scope: { orgId: 'org_int', userId: 'user_int', projectId: null },
      memoryService: memoryService as unknown as MemoryService,
      eventService: eventService as unknown as EventService,
      workDir,
      timeoutMs: 200,
      skillRegistry: registry,
    });
  }

  it('end-to-end: skill risk level flows through registry to policy block', async () => {
    const router = createRouterWithSkills([
      { name: 'dangerous', tools: ['memory_write'], risk_level: 'high' },
      { name: 'safe', tools: ['memory_search'], risk_level: 'low' },
    ]);

    const agent: AgentContext = {
      agentId: 'agent_e2e',
      roleId: 'role_e2e',
      allowedTools: [],
      deniedTools: [],
    };

    // high-risk tool requires approval by default policy
    const blocked = await router.callTool('memory_write', {
      type: 'episodic',
      text: 'test',
    }, agent);
    expect(blocked.success).toBe(false);
    expect(blocked.requiresApproval).toBe(true);

    // low-risk tool allowed
    const allowed = await router.callTool('memory_search', {
      query: 'test',
    }, agent);
    expect(allowed.success).toBe(true);
    expect(allowed.blocked).toBeUndefined();
  });

  it('denied_tools override skill risk level (deny low-risk tool)', async () => {
    const router = createRouterWithSkills([
      { name: 'safe', tools: ['memory_search', 'read_file'], risk_level: 'low' },
    ]);

    const agent: AgentContext = {
      agentId: 'agent_deny',
      roleId: 'role_deny',
      allowedTools: [],
      deniedTools: ['memory_search'],
    };

    // low-risk but explicitly denied
    const denied = await router.callTool('memory_search', {
      query: 'test',
    }, agent);
    expect(denied.success).toBe(false);
    expect(denied.blocked).toBe(true);
    expect(denied.error).toContain('explicitly denied');

    // same skill, different tool �?not denied
    await fs.promises.writeFile(path.join(workDir, 'hello.txt'), 'world');
    const ok = await router.callTool('read_file', {
      path: 'hello.txt',
    }, agent);
    expect(ok.success).toBe(true);
  });

  it('high-risk tool still requires approval even when whitelisted', async () => {
    const router = createRouterWithSkills([
      { name: 'dangerous', tools: ['memory_write'], risk_level: 'high' },
    ]);

    const agent: AgentContext = {
      agentId: 'agent_wl',
      roleId: 'role_wl',
      allowedTools: ['memory_write'],
      deniedTools: [],
    };

    const result = await router.callTool('memory_write', {
      type: 'episodic',
      text: 'whitelisted high-risk',
    }, agent);
    expect(result.success).toBe(false);
    expect(result.requiresApproval).toBe(true);
  });

  it('contextFromRole builds correct AgentContext for policy chain', async () => {
    const router = createRouterWithSkills([
      { name: 'mem', tools: ['memory_search', 'memory_write'], risk_level: 'medium' },
    ]);

    const role = {
      id: 'role_critic',
      name: 'Critic',
      system_prompt: 'You are a critic',
      allowed_tools: ['memory_search'],
      denied_tools: [],
      style_constraints: {},
      is_lead: false,
      description: '',
    };

    const ctx = ToolPolicy.contextFromRole(role, 'agent_critic_1');

    // memory_search is in whitelist �?allowed
    const searchResult = await router.callTool('memory_search', {
      query: 'test',
    }, ctx);
    expect(searchResult.success).toBe(true);

    // memory_write is NOT in whitelist �?blocked
    const writeResult = await router.callTool('memory_write', {
      type: 'episodic',
      text: 'test',
    }, ctx);
    expect(writeResult.success).toBe(false);
    expect(writeResult.blocked).toBe(true);
  });

  it('multiple roles with different permissions on same router', async () => {
    const router = createRouterWithSkills([
      { name: 'mem', tools: ['memory_search', 'memory_write', 'memory_get'], risk_level: 'medium' },
      { name: 'fs', tools: ['read_file'], risk_level: 'low' },
    ]);

    const reader: AgentContext = {
      agentId: 'agent_reader',
      roleId: 'role_reader',
      allowedTools: ['memory_search', 'read_file'],
      deniedTools: [],
    };

    const writer: AgentContext = {
      agentId: 'agent_writer',
      roleId: 'role_writer',
      allowedTools: ['memory_write'],
      deniedTools: [],
    };

    // reader can search but not write
    const readerSearch = await router.callTool('memory_search', { query: 'x' }, reader);
    expect(readerSearch.success).toBe(true);

    const readerWrite = await router.callTool('memory_write', {
      type: 'episodic', text: 'x',
    }, reader);
    expect(readerWrite.blocked).toBe(true);

    // writer can write but not search
    const writerWrite = await router.callTool('memory_write', {
      type: 'episodic', text: 'x',
    }, writer);
    expect(writerWrite.success).toBe(true);

    const writerSearch = await router.callTool('memory_search', { query: 'x' }, writer);
    expect(writerSearch.blocked).toBe(true);
  });
});

