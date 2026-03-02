import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeToolRouter } from './tool-router.js';
import type { MemoryService } from './memory-service.js';
import type { EventService } from './event-service.js';

interface FakeServerConfig {
  listMode?: 'valid' | 'invalid_shape' | 'conflict_memory_search';
  callMode?: 'text' | 'structured_error' | 'disconnect_then_recover' | 'invalid_shape';
}

interface FakeServerHandle {
  cwd: string;
  moduleName: string;
  cleanup: () => Promise<void>;
}

interface ManagedRouter {
  router: RuntimeToolRouter;
  cleanup: () => Promise<void>;
}

function buildFakeServerScript(config: FakeServerConfig): string {
  const listMode = config.listMode ?? 'valid';
  const callMode = config.callMode ?? 'text';

  return `import json
import os
import sys

CALL_MODE = ${JSON.stringify(callMode)}
LIST_MODE = ${JSON.stringify(listMode)}
MARKER_PATH = os.path.join(os.getcwd(), ".disconnect_once.flag")


def send_success(request_id, result):
    payload = {"jsonrpc": "2.0", "id": request_id, "result": result}
    sys.stdout.write(json.dumps(payload) + "\\n")
    sys.stdout.flush()


def send_error(request_id, code, message):
    payload = {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": code, "message": message}
    }
    sys.stdout.write(json.dumps(payload) + "\\n")
    sys.stdout.flush()


while True:
    raw = sys.stdin.readline()
    if not raw:
        break

    line = raw.strip()
    if not line:
        continue

    try:
        request = json.loads(line)
    except Exception:
        send_error(None, -32700, "parse error")
        continue

    method = request.get("method")
    request_id = request.get("id")
    params = request.get("params") or {}

    if method == "initialize":
        send_success(request_id, {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "fake-mcp", "version": "0.0.1"}
        })
        continue

    if method == "tools/list":
        if LIST_MODE == "invalid_shape":
            send_success(request_id, {"tools": {"name": "fake.echo"}})
            continue

        if LIST_MODE == "conflict_memory_search":
            tools = [{
                "name": "memory.search",
                "description": "MCP memory search",
                "inputSchema": {
                    "type": "object",
                    "properties": {"query": {"type": "string"}}
                }
            }]
        else:
            tools = [{
                "name": "fake.echo",
                "description": "Echo inputs",
                "inputSchema": {
                    "type": "object",
                    "properties": {"value": {"type": "string"}}
                }
            }]
        if os.path.exists(MARKER_PATH):
            tools.append({
                "name": "fake.after_reconnect",
                "description": "Available after reconnect",
                "inputSchema": {
                    "type": "object",
                    "properties": {"value": {"type": "string"}}
                }
            })
        send_success(request_id, {
            "tools": tools
        })
        continue

    if method == "tools/call":
        arguments = params.get("arguments") or {}

        if CALL_MODE == "disconnect_then_recover":
            if not os.path.exists(MARKER_PATH):
                with open(MARKER_PATH, "w", encoding="utf-8") as marker_file:
                    marker_file.write("disconnected-once")
                sys.stdout.flush()
                sys.stderr.flush()
                os._exit(0)

            send_success(request_id, {
                "content": [{
                    "type": "text",
                    "text": json.dumps({"ok": True, "arguments": arguments, "reconnected": True})
                }]
            })
            continue

        if CALL_MODE == "structured_error":
            send_success(request_id, {
                "content": [{"type": "text", "text": json.dumps({"fallback": "text"})}],
                "structuredContent": {"kind": "structured", "arguments": arguments},
                "isError": True
            })
            continue

        if CALL_MODE == "invalid_shape":
            send_success(request_id, {
                "content": "not-an-array"
            })
            continue

        send_success(request_id, {
            "content": [{"type": "text", "text": json.dumps({"ok": True, "arguments": arguments})}]
        })
        continue

    if method == "shutdown":
        send_success(request_id, {})
        break

    send_error(request_id, -32601, f"Unknown method: {method}")
`;
}

async function createFakeServer(config: FakeServerConfig = {}): Promise<FakeServerHandle> {
  const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fake-mcp-router-'));
  const moduleName = 'fake_mcp_server';
  const scriptPath = path.join(cwd, `${moduleName}.py`);
  await fs.promises.writeFile(scriptPath, buildFakeServerScript(config), 'utf-8');

  return {
    cwd,
    moduleName,
    cleanup: async () => {
      await fs.promises.rm(cwd, { recursive: true, force: true });
    },
  };
}

describe('RuntimeToolRouter MCP protocol behavior', () => {
  let workDir: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let memoryService: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let eventService: Record<string, any>;
  const managed: ManagedRouter[] = [];

  beforeEach(async () => {
    workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'runtime-mcp-router-'));
    memoryService = {
      memory_search: vi.fn().mockResolvedValue([]),
      memory_get: vi.fn().mockResolvedValue(null),
      memory_write: vi.fn().mockResolvedValue({ id: 'mem_1' }),
    };
    eventService = {
      list: vi.fn().mockResolvedValue({
        events: [],
        next_cursor: null,
      }),
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    while (managed.length > 0) {
      const entry = managed.pop();
      if (!entry) {
        continue;
      }
      await entry.router.stop().catch(() => undefined);
      await entry.cleanup();
    }
    await fs.promises.rm(workDir, { recursive: true, force: true });
  });

  async function createRouter(config: FakeServerConfig = {}): Promise<RuntimeToolRouter> {
    const fake = await createFakeServer(config);

    const router = new RuntimeToolRouter({
      scope: {
        orgId: 'org_test',
        userId: 'user_test',
        projectId: null,
      },
      memoryService: memoryService as unknown as MemoryService,
      eventService: eventService as unknown as EventService,
      workDir,
      timeoutMs: 1500,
      mcp: {
        enabled: true,
        pythonPath: 'python3',
        serverModule: fake.moduleName,
        cwd: fake.cwd,
        timeoutMs: 1500,
      },
    });

    managed.push({ router, cleanup: fake.cleanup });
    return router;
  }

  it('registers MCP tools and parses text content payload', async () => {
    const router = await createRouter({ callMode: 'text' });

    await router.start();

    const names = router.listTools().map((tool) => tool.name);
    expect(names).toContain('fake_echo');

    const result = await router.callTool('fake_echo', { value: 'abc' });
    expect(result.success).toBe(true);
    expect(result.result).toEqual({
      ok: true,
      arguments: { value: 'abc' },
    });
  });

  it('maps tools/call isError payload to failed tool result while preserving structured data', async () => {
    const router = await createRouter({ callMode: 'structured_error' });

    await router.start();

    const result = await router.callTool('fake_echo', { value: 'abc' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('MCP tool returned isError=true');
    expect(result.result).toMatchObject({
      isError: true,
      structuredContent: {
        kind: 'structured',
        arguments: { value: 'abc' },
      },
      content: {
        fallback: 'text',
      },
    });
  });

  it('reconnects after disconnect, refreshes tools/list, and continues tool calls', async () => {
    const router = await createRouter({ callMode: 'disconnect_then_recover' });

    await router.start();
    const beforeReconnect = router.listTools().map((tool) => tool.name);
    expect(beforeReconnect).toContain('fake_echo');
    expect(beforeReconnect).not.toContain('fake_after_reconnect');

    const firstCall = await router.callTool('fake_echo', { value: 'abc' });
    expect(firstCall.success).toBe(true);
    expect(firstCall.result).toEqual({
      ok: true,
      arguments: { value: 'abc' },
      reconnected: true,
    });

    const afterReconnect = router.listTools().map((tool) => tool.name);
    expect(afterReconnect).toContain('fake_after_reconnect');

    const secondCall = await router.callTool('fake_after_reconnect', { value: 'xyz' });
    expect(secondCall.success).toBe(true);
    expect(secondCall.result).toEqual({
      ok: true,
      arguments: { value: 'xyz' },
      reconnected: true,
    });
  });

  it('prefixes MCP tool names that collide with builtin tools', async () => {
    const router = await createRouter({ listMode: 'conflict_memory_search', callMode: 'text' });

    await router.start();

    const names = router.listTools().map((tool) => tool.name);
    expect(names).toContain('memory_search');
    expect(names).toContain('mcp__memory_search');

    const builtinResult = await router.callTool('memory_search', { query: 'builtin', top_k: 1 });
    expect(builtinResult.success).toBe(true);
    expect(memoryService.memory_search).toHaveBeenCalledTimes(1);

    const mcpResult = await router.callTool('mcp__memory_search', { query: 'mcp' });
    expect(mcpResult.success).toBe(true);
    expect(mcpResult.result).toEqual({
      ok: true,
      arguments: { query: 'mcp' },
    });
    expect(memoryService.memory_search).toHaveBeenCalledTimes(1);
  });

  it.fails('gap: should surface a typed schema error when tools/list returns malformed schema', async () => {
    const router = await createRouter({ listMode: 'invalid_shape', callMode: 'text' });

    await expect(router.start()).rejects.toThrow('Invalid MCP tools/list schema');
  });

  it.fails('gap: should mark malformed tools/call payload as tool failure', async () => {
    const router = await createRouter({ callMode: 'invalid_shape' });

    await router.start();
    const result = await router.callTool('fake_echo', { value: 'abc' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid|schema/i);
  });
});

