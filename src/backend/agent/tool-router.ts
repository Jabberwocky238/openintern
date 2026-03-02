/**
 * ToolRouter - Tool registration and execution routing
 *
 * Features:
 * - Tool registration and management
 * - Tool call routing
 * - Built-in memory tools
 * - Error handling and timeout control
 */

import type { ToolDefinition, ToolResult } from '@openintern/types/agent.js';
import type { EmbeddingConfig } from '@openintern/types/embedding.js';
import { MemoryStore } from '../store/memory-store.js';
import { ToolError } from '@openintern/utils';
import { generateMemoryId } from '@openintern/utils';
import { logger } from '@openintern/utils';
import { createFileTools } from './file-tools.js';
import { ToolSandbox, type ToolSandboxConfig } from './sandbox/index.js';
import { createEmbeddingProvider } from '../store/embedding-provider.js';
import { VectorIndex } from '../store/vector-index.js';
import { HybridSearcher } from '../store/hybrid-searcher.js';

/**
 * Tool interface with execute function
 */
export interface Tool extends ToolDefinition {
  execute: (params: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Tool router configuration
 */
export interface ToolRouterConfig {
  /** Default timeout for tool execution in ms */
  defaultTimeoutMs: number;
  /** Memory store base directory */
  memoryBaseDir: string;
  /** Base data directory (for file tools workspace) */
  baseDir: string;
  /** Custom working directory for file tools (absolute path, overrides baseDir/workspace) */
  workDir?: string;
  /** Sandbox configuration */
  sandbox?: ToolSandboxConfig;
  /** Embedding configuration for hybrid search */
  embedding?: EmbeddingConfig;
}

const DEFAULT_CONFIG: ToolRouterConfig = {
  defaultTimeoutMs: 30000, // 30 seconds
  memoryBaseDir: 'data/memory/shared',
  baseDir: 'data',
};

/**
 * ToolRouter class for managing and executing tools
 */
export class ToolRouter {
  private tools: Map<string, Tool> = new Map();
  private config: ToolRouterConfig;
  private memoryStore: MemoryStore;
  private sandbox: ToolSandbox | null = null;

  constructor(config: Partial<ToolRouterConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.memoryStore = new MemoryStore(this.config.memoryBaseDir);

    // Initialize hybrid search (vector + keyword)
    this.initHybridSearch();

    // Initialize sandbox if configured
    if (this.config.sandbox) {
      this.sandbox = new ToolSandbox(this.config.sandbox);
    }

    // Register built-in tools
    this.registerBuiltinTools();

    // Register file tools
    const fileTools = createFileTools(this.config.baseDir, this.config.workDir);
    for (const tool of fileTools) {
      this.registerTool(tool);
    }
  }

  /**
   * Initialize hybrid search with embedding provider and vector index
   */
  private initHybridSearch(): void {
    const embeddingConfig: EmbeddingConfig = this.config.embedding ?? {
      provider: 'hash',
      dimension: 256,
      alpha: 0.6,
    };

    try {
      const embeddingProvider = createEmbeddingProvider(embeddingConfig);
      const vectorIndex = new VectorIndex(
        this.config.memoryBaseDir,
        embeddingConfig.dimension,
      );
      const searcher = new HybridSearcher(
        vectorIndex,
        embeddingProvider,
        embeddingConfig.alpha,
      );

      // Load persisted vector index (non-blocking)
      void searcher.load().catch((err) => {
        logger.warn('Failed to load vector index', {
          error: err instanceof Error ? err.message : String(err),
        });
      });

      this.memoryStore.setHybridSearcher(searcher);
      logger.info('Hybrid search initialized', {
        provider: embeddingConfig.provider,
        dimension: embeddingConfig.dimension,
      });
    } catch (err) {
      logger.warn('Failed to initialize hybrid search, using keyword-only', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Register built-in memory tools
   */
  private registerBuiltinTools(): void {
    // memory_write tool
    this.registerTool({
      name: 'memory_write',
      description: 'Write content to memory for later retrieval',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The content to store in memory',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional tags for categorization',
          },
        },
        required: ['content'],
      },
      execute: async (params) => {
        return this.executeMemoryWrite(params);
      },
    });

    // memory_search tool
    this.registerTool({
      name: 'memory_search',
      description: 'Search memory for relevant content',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query',
          },
          topK: {
            type: 'number',
            description: 'Maximum number of results (default: 5)',
          },
        },
        required: ['query'],
      },
      execute: async (params) => {
        return this.executeMemorySearch(params);
      },
    });

    // memory_get tool
    this.registerTool({
      name: 'memory_get',
      description: 'Get a specific memory item by ID',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Memory item ID',
          },
        },
        required: ['id'],
      },
      execute: async (params) => {
        return this.executeMemoryGet(params);
      },
    });

    logger.info('Built-in tools registered', {
      tools: ['memory_write', 'memory_search', 'memory_get'],
    });
  }

  /**
   * Execute memory.write tool
   */
  private async executeMemoryWrite(
    params: Record<string, unknown>
  ): Promise<{ id: string; success: boolean }> {
    const content = params['content'] as string;
    const tags = (params['tags'] as string[]) ?? [];

    if (!content || typeof content !== 'string') {
      throw new ToolError('content is required and must be a string', 'memory_write');
    }

    const now = new Date().toISOString();
    const id = generateMemoryId();

    await this.memoryStore.write({
      id,
      created_at: now,
      updated_at: now,
      content,
      keywords: tags,
    });

    logger.debug('Memory written', { id, contentLength: content.length });

    return { id, success: true };
  }

  /**
   * Execute memory.search tool
   */
  private async executeMemorySearch(
    params: Record<string, unknown>
  ): Promise<{ results: Array<{ id: string; content: string; score: number }> }> {
    const query = params['query'] as string;
    const topK = (params['topK'] as number) ?? 5;

    if (!query || typeof query !== 'string') {
      throw new ToolError('query is required and must be a string', 'memory_search');
    }

    // Use hybrid search (vector + keyword) when available
    const hybridResults = await this.memoryStore.searchHybrid(query, topK);

    const results = hybridResults.map((hr) => ({
      id: hr.item.id,
      content: hr.item.content,
      score: hr.score,
    }));

    logger.debug('Memory search completed', { query, resultCount: results.length });

    return { results };
  }

  /**
   * Execute memory.get tool
   */
  private async executeMemoryGet(
    params: Record<string, unknown>
  ): Promise<{ item: { id: string; content: string; keywords: string[] } | null }> {
    const id = params['id'] as string;

    if (!id || typeof id !== 'string') {
      throw new ToolError('id is required and must be a string', 'memory_get');
    }

    const item = await this.memoryStore.get(id);

    if (!item) {
      return { item: null };
    }

    return {
      item: {
        id: item.id,
        content: item.content,
        keywords: item.keywords,
      },
    };
  }

  /**
   * Register a new tool
   */
  registerTool(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      logger.warn('Tool already registered, overwriting', { name: tool.name });
    }

    this.tools.set(tool.name, tool);
    logger.debug('Tool registered', { name: tool.name });
  }

  /**
   * Unregister a tool
   */
  unregisterTool(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Get a tool by name
   */
  getTool(name: string): Tool | null {
    return this.tools.get(name) ?? null;
  }

  /**
   * List all registered tools
   */
  listTools(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  /**
   * Call a tool by name with parameters
   */
  async callTool(name: string, params: Record<string, unknown>): Promise<ToolResult> {
    const startTime = Date.now();

    const tool = this.tools.get(name);
    if (!tool) {
      return {
        success: false,
        error: `Tool not found: ${name}`,
        duration: Date.now() - startTime,
      };
    }

    logger.debug('Calling tool', { name, params });

    try {
      // Sandbox pre-validation
      if (this.sandbox) {
        const workDir = this.config.workDir
          ? this.config.workDir
          : this.config.baseDir + '/workspace';
        await this.sandbox.validate(name, params, workDir);
      }

      // Execute with timeout
      const result = await Promise.race([
        tool.execute(params),
        this.createTimeout(name),
      ]);

      const duration = Date.now() - startTime;

      logger.debug('Tool call completed', { name, duration });

      return {
        success: true,
        result,
        duration,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('Tool call failed', { name, error: errorMessage, duration });

      return {
        success: false,
        error: errorMessage,
        duration,
      };
    }
  }

  /**
   * Create a timeout promise
   */
  private createTimeout(toolName: string): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new ToolError(
          `Tool execution timed out after ${this.config.defaultTimeoutMs}ms`,
          toolName
        ));
      }, this.config.defaultTimeoutMs);
    });
  }

  /**
   * Check if a tool exists
   */
  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get tool count
   */
  getToolCount(): number {
    return this.tools.size;
  }
}

