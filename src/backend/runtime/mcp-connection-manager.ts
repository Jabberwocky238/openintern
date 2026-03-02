import { MCPClient, type MCPClientConfig } from '../agent/mcp-client.js';
import { logger } from '@openintern/utils';

/**
 * Per-server configuration for MCP connections.
 */
export interface McpServerConfig {
  /** Unique server identifier */
  id: string;
  /** Display name */
  name: string;
  /** Python path override */
  pythonPath?: string;
  /** Python module to run */
  serverModule?: string;
  /** Working directory */
  cwd?: string;
  /** Request timeout in ms */
  timeoutMs?: number;
  /** Whether this server is enabled */
  enabled?: boolean;
}

/**
 * Health state for a single MCP server connection.
 */
export interface McpServerState {
  id: string;
  name: string;
  status: 'connected' | 'disconnected' | 'error' | 'connecting';
  toolCount: number;
  lastError?: string;
  lastConnectedAt?: string;
  reconnectAttempts: number;
}

/**
 * Aggregated tool definition with server prefix.
 */
export interface McpAggregatedTool {
  /** Namespaced tool name: mcp__<server>__<tool> */
  name: string;
  /** Original tool name on the server */
  originalName: string;
  /** Server ID this tool belongs to */
  serverId: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 1000;

/**
 * McpConnectionManager maintains multiple MCP server connections,
 * aggregates tools with namespaced naming (mcp__<server>__<tool>),
 * and handles per-server health, timeout, and reconnection.
 *
 * Single server failure does not affect other servers or builtin tools.
 */
export class McpConnectionManager {
  private readonly clients = new Map<string, MCPClient>();
  private readonly configs = new Map<string, McpServerConfig>();
  private readonly states = new Map<string, McpServerState>();
  private readonly toolCache = new Map<string, McpAggregatedTool[]>();

  /**
   * Initialize connections to all configured MCP servers.
   */
  async initialize(servers: McpServerConfig[]): Promise<void> {
    const results = await Promise.allSettled(
      servers
        .filter((s) => s.enabled !== false)
        .map((s) => this.connectServer(s))
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        logger.warn('MCP server failed to connect during init', {
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }

    logger.info('McpConnectionManager initialized', {
      total: servers.length,
      connected: [...this.states.values()].filter((s) => s.status === 'connected').length,
    });
  }

  /**
   * Connect to a single MCP server.
   */
  private async connectServer(config: McpServerConfig): Promise<void> {
    this.configs.set(config.id, config);
    this.states.set(config.id, {
      id: config.id,
      name: config.name,
      status: 'connecting',
      toolCount: 0,
      reconnectAttempts: 0,
    });

    const clientConfig: MCPClientConfig = {
      ...(config.pythonPath ? { pythonPath: config.pythonPath } : {}),
      ...(config.serverModule ? { serverModule: config.serverModule } : {}),
      ...(config.cwd ? { cwd: config.cwd } : {}),
      ...(config.timeoutMs !== undefined ? { timeout: config.timeoutMs } : {}),
    };

    const client = new MCPClient(clientConfig);

    try {
      await client.start();
      this.clients.set(config.id, client);

      // Fetch initial tool list
      await this.refreshServerTools(config.id);

      this.states.set(config.id, {
        ...this.states.get(config.id)!,
        status: 'connected',
        lastConnectedAt: new Date().toISOString(),
        reconnectAttempts: 0,
      });

      logger.info('MCP server connected', { id: config.id, name: config.name });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.states.set(config.id, {
        ...this.states.get(config.id)!,
        status: 'error',
        lastError: message,
      });
      logger.error('MCP server connection failed', { id: config.id, error: message });
      throw err;
    }
  }

  /**
   * Refresh tool list for a specific server.
   * Returns added/removed tool names for event emission.
   */
  async refreshServerTools(serverId: string): Promise<{ added: string[]; removed: string[] }> {
    const client = this.clients.get(serverId);
    if (!client || !client.isRunning()) {
      return { added: [], removed: [] };
    }

    const oldTools = this.toolCache.get(serverId) ?? [];
    const oldNames = new Set(oldTools.map((t) => t.name));

    const rawTools = await client.listTools();
    const newTools: McpAggregatedTool[] = rawTools.map((t) => ({
      name: `mcp__${serverId}__${t.name}`,
      originalName: t.name,
      serverId,
      description: t.description,
      inputSchema: t.inputSchema,
    }));

    this.toolCache.set(serverId, newTools);

    const newNames = new Set(newTools.map((t) => t.name));
    const added = newTools.filter((t) => !oldNames.has(t.name)).map((t) => t.name);
    const removed = oldTools.filter((t) => !newNames.has(t.name)).map((t) => t.name);

    const state = this.states.get(serverId);
    if (state) {
      state.toolCount = newTools.length;
    }

    return { added, removed };
  }

  /**
   * List all aggregated tools across all connected servers.
   */
  listTools(): McpAggregatedTool[] {
    const all: McpAggregatedTool[] = [];
    for (const tools of this.toolCache.values()) {
      all.push(...tools);
    }
    return all;
  }

  /**
   * Call a tool on the appropriate server.
   * Accepts either namespaced (mcp__server__tool) or original tool names.
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    // Find the tool across all servers
    for (const [serverId, tools] of this.toolCache.entries()) {
      const tool = tools.find((t) => t.name === toolName || t.originalName === toolName);
      if (!tool) continue;

      const client = this.clients.get(serverId);
      if (!client || !client.isRunning()) {
        // Try reconnect
        await this.tryReconnect(serverId);
        const reconnected = this.clients.get(serverId);
        if (!reconnected?.isRunning()) {
          throw new Error(`MCP server ${serverId} is not available`);
        }
        return reconnected.callTool(tool.originalName, args);
      }

      return client.callTool(tool.originalName, args);
    }

    throw new Error(`MCP tool not found: ${toolName}`);
  }

  /**
   * Attempt to reconnect a failed server with exponential backoff.
   */
  private async tryReconnect(serverId: string): Promise<void> {
    const state = this.states.get(serverId);
    const config = this.configs.get(serverId);
    if (!state || !config) return;

    if (state.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logger.warn('MCP server max reconnect attempts reached', { id: serverId });
      return;
    }

    state.reconnectAttempts++;
    const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, state.reconnectAttempts - 1);

    logger.info('Attempting MCP server reconnect', {
      id: serverId,
      attempt: state.reconnectAttempts,
      delay,
    });

    await new Promise((r) => setTimeout(r, delay));

    // Stop existing client
    const existing = this.clients.get(serverId);
    if (existing) {
      await existing.stop().catch(() => {});
      this.clients.delete(serverId);
    }

    try {
      await this.connectServer(config);
    } catch {
      // connectServer already updates state on failure
    }
  }

  /**
   * List resources available on a specific server.
   */
  async listResources(serverId: string): Promise<unknown[]> {
    const client = this.clients.get(serverId);
    if (!client?.isRunning()) return [];
    try {
      const result = await client.request('resources/list') as { resources?: unknown[] };
      return result?.resources ?? [];
    } catch {
      return [];
    }
  }

  /**
   * List resource templates on a specific server.
   */
  async listResourceTemplates(serverId: string): Promise<unknown[]> {
    const client = this.clients.get(serverId);
    if (!client?.isRunning()) return [];
    try {
      const result = await client.request('resources/templates/list') as { resourceTemplates?: unknown[] };
      return result?.resourceTemplates ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Read a resource from a specific server.
   */
  async readResource(serverId: string, uri: string): Promise<unknown> {
    const client = this.clients.get(serverId);
    if (!client?.isRunning()) {
      throw new Error(`MCP server ${serverId} is not available`);
    }
    return client.request('resources/read', { uri });
  }

  /**
   * Get health states for all servers.
   */
  getServerStates(): McpServerState[] {
    return [...this.states.values()];
  }

  /**
   * Get state for a specific server.
   */
  getServerState(serverId: string): McpServerState | undefined {
    return this.states.get(serverId);
  }

  /**
   * Gracefully shut down all MCP server connections.
   */
  async shutdown(): Promise<void> {
    const stops = [...this.clients.entries()].map(async ([id, client]) => {
      try {
        await client.stop();
      } catch (err) {
        logger.warn('Error stopping MCP server', {
          id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
    await Promise.allSettled(stops);
    this.clients.clear();
    this.toolCache.clear();
    for (const state of this.states.values()) {
      state.status = 'disconnected';
    }
    logger.info('McpConnectionManager shut down');
  }
}

