/**
 * CLI Command: agent dev
 *
 * Start development server with Backend + MCP Server
 */

import { createServer, type ServerInstance } from '../../backend/server.js';
import { loadConfig, toLLMConfig, toPlannerLLMConfig } from '../../config/loader.js';
import * as output from '../utils/output.js';

const DEFAULT_PYTHON_PATH = process.platform === 'win32' ? 'python' : 'python3';

export interface DevOptions {
  port: number;
  mcpStdio: boolean;
  web: boolean;
  provider?: string;
  model?: string;
}

/**
 * Execute the dev command
 */
export async function devCommand(options: DevOptions): Promise<void> {
  output.header('Starting Agent Development Server');

  let server: ServerInstance | null = null;

  // Setup graceful shutdown
  const shutdown = async (): Promise<void> => {
    output.print('');
    output.info('Shutting down...');

    if (server) {
      await server.stop();
      output.success('Backend Server stopped');
    }

    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  try {
    // Load config file + env vars
    const agentConfig = await loadConfig();

    // Build server config: config file < CLI options
    const serverConfig: Parameters<typeof createServer>[0] = {
      port: agentConfig.server?.port ?? options.port,
      baseDir: agentConfig.server?.baseDir ?? 'data',
    };
    if (agentConfig.server?.corsOrigins) {
      serverConfig.corsOrigins = agentConfig.server.corsOrigins;
    }
    if (agentConfig.server?.databaseUrl) {
      serverConfig.databaseUrl = agentConfig.server.databaseUrl;
    }
    if (agentConfig.embedding) {
      serverConfig.embeddingConfig = {
        provider: agentConfig.embedding.provider ?? 'hash',
        dimension: agentConfig.embedding.dimension ?? 256,
        alpha: agentConfig.embedding.alpha ?? 0.6,
        ...(agentConfig.embedding.apiUrl ? { apiUrl: agentConfig.embedding.apiUrl } : {}),
        ...(agentConfig.embedding.apiModel ? { apiModel: agentConfig.embedding.apiModel } : {}),
      };
    }
    if (agentConfig.feishu) {
      serverConfig.feishu = {
        ...(agentConfig.feishu.enabled !== undefined
          ? { enabled: agentConfig.feishu.enabled }
          : {}),
        ...(agentConfig.feishu.appId ? { appId: agentConfig.feishu.appId } : {}),
        ...(agentConfig.feishu.appSecret ? { appSecret: agentConfig.feishu.appSecret } : {}),
        ...(agentConfig.feishu.baseUrl ? { baseUrl: agentConfig.feishu.baseUrl } : {}),
        ...(agentConfig.feishu.timeoutMs ? { timeoutMs: agentConfig.feishu.timeoutMs } : {}),
        ...(agentConfig.feishu.maxRetries ? { maxRetries: agentConfig.feishu.maxRetries } : {}),
        ...(agentConfig.feishu.pollIntervalMs
          ? { pollIntervalMs: agentConfig.feishu.pollIntervalMs }
          : {}),
      };
    }
    if (agentConfig.mineru) {
      serverConfig.mineru = {
        ...(agentConfig.mineru.enabled !== undefined
          ? { enabled: agentConfig.mineru.enabled }
          : {}),
        ...(agentConfig.mineru.mode ? { mode: agentConfig.mineru.mode } : {}),
        ...(agentConfig.mineru.apiKey ? { apiKey: agentConfig.mineru.apiKey } : {}),
        ...(agentConfig.mineru.baseUrl ? { baseUrl: agentConfig.mineru.baseUrl } : {}),
        ...(agentConfig.mineru.uidToken ? { uidToken: agentConfig.mineru.uidToken } : {}),
        ...(agentConfig.mineru.timeoutMs ? { timeoutMs: agentConfig.mineru.timeoutMs } : {}),
        ...(agentConfig.mineru.maxRetries ? { maxRetries: agentConfig.mineru.maxRetries } : {}),
        ...(agentConfig.mineru.pollIntervalMs
          ? { pollIntervalMs: agentConfig.mineru.pollIntervalMs }
          : {}),
        ...(agentConfig.mineru.maxPollAttempts
          ? { maxPollAttempts: agentConfig.mineru.maxPollAttempts }
          : {}),
        ...(agentConfig.mineru.defaultModelVersion
          ? { defaultModelVersion: agentConfig.mineru.defaultModelVersion }
          : {}),
      };
    }
    serverConfig.mcp = {
      enabled: options.mcpStdio,
      pythonPath: process.env['PYTHON_PATH'] ?? DEFAULT_PYTHON_PATH,
      serverModule: 'mcp_server.server',
      cwd: 'python',
      timeoutMs: 30000,
    };

    // LLM config: config file as base, CLI options override
    if (options.provider) {
      const provider = options.provider as 'openai' | 'anthropic' | 'gemini' | 'mock';
      serverConfig.defaultModelConfig = {
        provider,
        model: options.model ?? (
          provider === 'openai'
            ? 'gpt-4o'
            : provider === 'gemini'
              ? 'gemini-3-pro-preview'
              : 'claude-sonnet-4-20250514'
        ),
      };
    } else {
      const llmConfig = toLLMConfig(agentConfig);
      if (llmConfig) {
        serverConfig.defaultModelConfig = llmConfig;
      }
    }

    const plannerLlmConfig = toPlannerLLMConfig(agentConfig);
    if (plannerLlmConfig) {
      serverConfig.planner = { llm: plannerLlmConfig };
    }

    // Agent config
    if (agentConfig.agent?.maxSteps) {
      serverConfig.maxSteps = agentConfig.agent.maxSteps;
    }
    if (agentConfig.agent?.persistLlmTokens !== undefined) {
      serverConfig.persistLlmTokens = agentConfig.agent.persistLlmTokens;
    }
    if (agentConfig.agent?.workDir) {
      serverConfig.workDir = agentConfig.agent.workDir;
    }

    // Start Backend Server
    output.progress('Starting Backend Server');
    server = createServer(serverConfig);
    await server.start();
    output.progressDone();
    output.success(`Backend Server started at http://localhost:${serverConfig.port ?? options.port}`);

    if (options.mcpStdio) {
      output.info('MCP tools: enabled (started on demand by runtime)');
    } else {
      output.info('MCP tools: disabled');
    }

    // Web UI info
    if (options.web) {
      output.info('Web UI: Run "pnpm dev:web" in another terminal');
    }

    output.print('');
    output.print('Press Ctrl+C to stop');
    output.print('');

    // Keep process running
    await new Promise(() => {
      // Never resolves - wait for shutdown signal
    });
  } catch (err) {
    output.error(
      `Failed to start server: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }
}
