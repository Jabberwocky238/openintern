import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MCPClient, type MCPTool } from './mcp-client.js';

interface FakeServerConfig {
  strictHandshake?: boolean;
  listMode?: 'valid' | 'invalid_shape';
  callMode?: 'text' | 'structured_error' | 'invalid_shape';
}

interface FakeServerHandle {
  cwd: string;
  moduleName: string;
  cleanup: () => Promise<void>;
}

interface ManagedClient {
  client: MCPClient;
  cleanup: () => Promise<void>;
}

const TEST_PYTHON_PATH = process.platform === 'win32' ? 'python' : 'python3';

function buildFakeServerScript(config: FakeServerConfig): string {
  const strictHandshake = config.strictHandshake ? 'True' : 'False';
  const listMode = config.listMode ?? 'valid';
  const callMode = config.callMode ?? 'text';

  return `import json
import sys

STRICT_HANDSHAKE = ${strictHandshake}
LIST_MODE = ${JSON.stringify(listMode)}
CALL_MODE = ${JSON.stringify(callMode)}
client_initialized = False

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

    if method == "notifications/initialized":
        client_initialized = True
        continue

    if method == "initialize":
        send_success(request_id, {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "fake-mcp", "version": "0.0.1"}
        })
        continue

    if method == "tools/list":
        if STRICT_HANDSHAKE and not client_initialized:
            send_error(request_id, -32002, "notifications/initialized required")
            continue

        if LIST_MODE == "invalid_shape":
            send_success(request_id, {"tools": {"name": "fake.echo"}})
            continue

        send_success(request_id, {
            "tools": [
                {
                    "name": "fake.echo",
                    "description": "Echo inputs",
                    "inputSchema": {
                        "type": "object",
                        "properties": {"value": {"type": "string"}}
                    }
                }
            ]
        })
        continue

    if method == "tools/call":
        name = params.get("name")
        arguments = params.get("arguments") or {}

        if name == "explode":
            send_error(request_id, -32050, "tool exploded")
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
            "content": [
                {
                    "type": "text",
                    "text": json.dumps({"ok": True, "arguments": arguments})
                }
            ]
        })
        continue

    if method == "shutdown":
        send_success(request_id, {})
        break

    send_error(request_id, -32601, f"Unknown method: {method}")
`;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for condition');
}

async function createFakeServer(config: FakeServerConfig = {}): Promise<FakeServerHandle> {
  const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fake-mcp-client-'));
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

describe('MCPClient protocol (fake server)', () => {
  const managed: ManagedClient[] = [];

  afterEach(async () => {
    while (managed.length > 0) {
      const entry = managed.pop();
      if (!entry) {
        continue;
      }
      await entry.client.stop().catch(() => undefined);
      await entry.cleanup();
    }
  });

  async function createClient(config: FakeServerConfig = {}): Promise<MCPClient> {
    const fake = await createFakeServer(config);
    const client = new MCPClient({
      pythonPath: TEST_PYTHON_PATH,
      serverModule: fake.moduleName,
      cwd: fake.cwd,
      timeout: 1500,
    });
    managed.push({ client, cleanup: fake.cleanup });
    return client;
  }

  it('supports tools/list and tools/call with fake MCP server', async () => {
    const client = await createClient({ callMode: 'text' });

    await client.start();

    const tools = await client.listTools();
    const toolNames = tools.map((tool: MCPTool) => tool.name);
    expect(toolNames).toContain('fake.echo');

    const result = await client.callTool('fake.echo', { value: 'abc' }) as {
      content: Array<{ type: string; text: string }>;
    };

    expect(result.content[0]?.type).toBe('text');
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
      ok: boolean;
      arguments: Record<string, unknown>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.arguments).toEqual({ value: 'abc' });
  });

  it('rejects tools/call when fake server returns protocol error', async () => {
    const client = await createClient({ callMode: 'text' });

    await client.start();

    await expect(client.callTool('explode', {})).rejects.toThrow('tool exploded');
  });

  it('sends notifications/initialized before tools/list', async () => {
    const client = await createClient({ strictHandshake: true, callMode: 'text' });

    await client.start();
    const tools = await client.listTools();

    expect(tools.length).toBeGreaterThan(0);
    expect(tools.map((tool: MCPTool) => tool.name)).toContain('fake.echo');
  });

  it('can start again after server-side shutdown and continue listing tools', async () => {
    const client = await createClient({ callMode: 'text' });

    await client.start();
    await client.request('shutdown');
    await waitFor(() => !client.isRunning());

    await client.start();
    const tools = await client.listTools();
    expect(tools.map((tool: MCPTool) => tool.name)).toContain('fake.echo');
  });

  it.fails('gap: should reject malformed tools/list payload shape', async () => {
    const client = await createClient({ listMode: 'invalid_shape', callMode: 'text' });

    await client.start();
    await expect(client.listTools()).rejects.toThrow(/tools/i);
  });

  it.fails('gap: should reject malformed tools/call payload shape', async () => {
    const client = await createClient({ callMode: 'invalid_shape' });

    await client.start();
    await expect(client.callTool('fake.echo', { value: 'abc' })).rejects.toThrow(/invalid|schema/i);
  });
});

