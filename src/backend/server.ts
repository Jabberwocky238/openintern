/**
 * Backend Server - Express server with API routes
 *
 * Features:
 * - REST API for runs management
 * - SSE event streaming
 * - CORS support
 * - Request logging middleware
 * - Error handling middleware
 * - Graceful shutdown
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { createRunsRouter } from './api/runs.js';
import { createRolesRouter } from './api/roles.js';
import { createGroupsRouter } from './api/groups.js';
import { createBlackboardRouter } from './api/blackboard.js';
import { createSkillsRouter } from './api/skills.js';
import { createFeishuConnectorsRouter } from './api/feishu-connectors.js';
import { createFeishuImRouter } from './api/feishu-im.js';
import { createUploadsRouter } from './api/uploads.js';
import { createMineruRouter } from './api/mineru.js';
import { RunQueue } from './queue/run-queue.js';
import { SSEManager } from './api/sse.js';
import { AgentError } from '../utils/errors.js';
import type { LLMConfig } from '../types/agent.js';
import type { EmbeddingConfig } from '../types/embedding.js';
import { logger } from '../utils/logger.js';
import type { ErrorResponse } from '../types/api.js';
import { createEmbeddingProvider } from './store/embedding-provider.js';
import {
  CheckpointService,
  createRuntimeExecutor,
  EventService,
  MemoryService,
  PlanRepository,
  RunRepository,
} from './runtime/index.js';
import { RoleRepository } from './runtime/role-repository.js';
import { GroupRepository } from './runtime/group-repository.js';
import { SkillRepository } from './runtime/skill/repository.js';
import { PluginRepository } from './runtime/plugin/repository.js';
import { FeishuRepository } from './runtime/integrations/feishu/repository.js';
import { FeishuClient } from './runtime/integrations/feishu/client.js';
import { FeishuImService } from './channels/feishu/im-service.js';
import { FeishuSyncService } from './runtime/integrations/feishu/sync-service.js';
import { MineruClient } from './runtime/integrations/mineru/client.js';
import { MineruIngestService } from './runtime/integrations/mineru/ingest-service.js';
import { UploadService } from './runtime/upload-service.js';
import { closeSharedPostgresPool, getPostgresPool, runPostgresMigrations } from './db/index.js';

/**
 * Server configuration
 */
export interface ServerConfig {
  port: number;
  baseDir: string;
  corsOrigins: string | string[];
  defaultModelConfig?: LLMConfig;
  planner?: {
    llm?: LLMConfig;
  };
  maxSteps?: number;
  persistLlmTokens?: boolean;
  workDir?: string;
  embedding?: EmbeddingConfig;
  databaseUrl?: string;
  embeddingConfig?: EmbeddingConfig;
  mcp?: {
    enabled: boolean;
    pythonPath?: string;
    serverModule?: string;
    cwd?: string;
    timeoutMs?: number;
  };
  feishu?: {
    enabled?: boolean;
    appId?: string;
    appSecret?: string;
    baseUrl?: string;
    timeoutMs?: number;
    maxRetries?: number;
    pollIntervalMs?: number;
    im?: {
      enabled?: boolean;
      verifyToken?: string;
      defaultOrgId?: string;
      defaultUserId?: string;
      defaultProjectId?: string;
      agentId?: string;
      sessionPrefix?: string;
      waitTimeoutMs?: number;
      pollIntervalMs?: number;
    };
  };
  mineru?: {
    enabled?: boolean;
    mode?: 'v4';
    apiKey?: string;
    baseUrl?: string;
    uidToken?: string;
    timeoutMs?: number;
    maxRetries?: number;
    pollIntervalMs?: number;
    maxPollAttempts?: number;
    defaultModelVersion?: 'pipeline' | 'vlm' | 'MinerU-HTML';
  };
}

const DEFAULT_CONFIG: ServerConfig = {
  port: 3000,
  baseDir: 'data',
  corsOrigins: '*',
};

/**
 * Create and configure the Express application
 */
export function createApp(config: Partial<ServerConfig> = {}): {
  app: Express;
  runQueue: RunQueue;
  sseManager: SSEManager;
  dbReady: Promise<void>;
  feishuSyncService: FeishuSyncService;
} {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  const app = express();

  // Create shared instances
  const runQueue = new RunQueue({ persistDir: finalConfig.baseDir });
  const sseManager = new SSEManager();

  const pool = getPostgresPool(
    finalConfig.databaseUrl ? { connectionString: finalConfig.databaseUrl } : {}
  );
  const dbReady = runPostgresMigrations(pool);
  const runRepository = new RunRepository(pool);
  const planRepository = new PlanRepository(pool);
  const roleRepository = new RoleRepository(pool);
  const groupRepository = new GroupRepository(pool);
  const skillRepository = new SkillRepository(pool);
  const pluginRepository = new PluginRepository(pool);
  const feishuRepository = new FeishuRepository(pluginRepository);
  const eventService = new EventService(runRepository);
  const checkpointService = new CheckpointService(runRepository, pool);
  const requestedEmbedding = finalConfig.embeddingConfig ?? finalConfig.embedding ?? {
    provider: 'hash',
    dimension: 256,
    alpha: 0.6,
  };
  if (requestedEmbedding.dimension !== 256) {
    logger.warn('Embedding dimension overridden to 256 to match pgvector schema', {
      requested: requestedEmbedding.dimension,
    });
  }
  const embeddingProvider = createEmbeddingProvider({
    ...requestedEmbedding,
    dimension: 256,
  });
  const memoryService = new MemoryService(pool, embeddingProvider);

  const feishuEnabledByConfig = Boolean(
    finalConfig.feishu?.enabled ??
      (finalConfig.feishu?.appId && finalConfig.feishu?.appSecret)
  );
  const feishuClient =
    feishuEnabledByConfig && finalConfig.feishu?.appId && finalConfig.feishu?.appSecret
      ? new FeishuClient({
          appId: finalConfig.feishu.appId,
          appSecret: finalConfig.feishu.appSecret,
          ...(finalConfig.feishu.baseUrl ? { baseUrl: finalConfig.feishu.baseUrl } : {}),
          ...(finalConfig.feishu.timeoutMs ? { timeoutMs: finalConfig.feishu.timeoutMs } : {}),
          ...(finalConfig.feishu.maxRetries ? { maxRetries: finalConfig.feishu.maxRetries } : {}),
        })
      : null;
  const feishuImEnabledByConfig = Boolean(finalConfig.feishu?.im?.enabled);
  if (feishuImEnabledByConfig && !feishuClient) {
    logger.warn('Feishu IM is enabled but appId/appSecret are not configured; IM webhook will be inactive');
  }
  const feishuImService = new FeishuImService(
    runRepository,
    runQueue,
    feishuClient,
    {
      enabled: feishuImEnabledByConfig && feishuClient !== null,
      ...(finalConfig.feishu?.im?.verifyToken
        ? { verifyToken: finalConfig.feishu.im.verifyToken }
        : {}),
      ...(finalConfig.feishu?.im?.defaultOrgId
        ? { defaultOrgId: finalConfig.feishu.im.defaultOrgId }
        : {}),
      ...(finalConfig.feishu?.im?.defaultUserId
        ? { defaultUserId: finalConfig.feishu.im.defaultUserId }
        : {}),
      ...(finalConfig.feishu?.im?.defaultProjectId
        ? { defaultProjectId: finalConfig.feishu.im.defaultProjectId }
        : {}),
      ...(finalConfig.feishu?.im?.agentId
        ? { defaultAgentId: finalConfig.feishu.im.agentId }
        : {}),
      ...(finalConfig.feishu?.im?.sessionPrefix
        ? { sessionPrefix: finalConfig.feishu.im.sessionPrefix }
        : {}),
      ...(finalConfig.feishu?.im?.waitTimeoutMs
        ? { waitTimeoutMs: finalConfig.feishu.im.waitTimeoutMs }
        : {}),
      ...(finalConfig.feishu?.im?.pollIntervalMs
        ? { pollIntervalMs: finalConfig.feishu.im.pollIntervalMs }
        : {}),
    }
  );
  const feishuSyncService = new FeishuSyncService(
    feishuRepository,
    memoryService,
    feishuClient,
    {
      enabled: feishuEnabledByConfig,
      ...(finalConfig.feishu?.pollIntervalMs
        ? { pollIntervalMs: finalConfig.feishu.pollIntervalMs }
        : {}),
    }
  );
  const mineruEnabledByConfig = Boolean(
    finalConfig.mineru?.enabled ??
      finalConfig.mineru?.apiKey
  );
  const mineruHasRequiredConfig = Boolean(finalConfig.mineru?.apiKey);
  const mineruClient =
    mineruEnabledByConfig && mineruHasRequiredConfig
      ? new MineruClient({
          ...(finalConfig.mineru?.mode ? { mode: finalConfig.mineru.mode } : {}),
          ...(finalConfig.mineru?.apiKey ? { apiKey: finalConfig.mineru.apiKey } : {}),
          ...(finalConfig.mineru?.baseUrl ? { baseUrl: finalConfig.mineru.baseUrl } : {}),
          ...(finalConfig.mineru?.uidToken ? { uidToken: finalConfig.mineru.uidToken } : {}),
          ...(finalConfig.mineru?.timeoutMs ? { timeoutMs: finalConfig.mineru.timeoutMs } : {}),
          ...(finalConfig.mineru?.maxRetries ? { maxRetries: finalConfig.mineru.maxRetries } : {}),
        })
      : null;
  const mineruIngestService = new MineruIngestService(
    memoryService,
    mineruClient,
    {
      enabled: mineruEnabledByConfig,
      ...(finalConfig.mineru?.pollIntervalMs
        ? { pollIntervalMs: finalConfig.mineru.pollIntervalMs }
        : {}),
      ...(finalConfig.mineru?.maxPollAttempts
        ? { maxPollAttempts: finalConfig.mineru.maxPollAttempts }
        : {}),
      ...(finalConfig.mineru?.defaultModelVersion
        ? { defaultModelVersion: finalConfig.mineru.defaultModelVersion }
        : {}),
    }
  );

  // Set up runtime executor for the run queue
  const runtimeExecutor = createRuntimeExecutor({
    runRepository,
    planRepository,
    eventService,
    checkpointService,
    memoryService,
    skillRepository,
    sseManager,
    groupRepository,
    roleRepository,
    feishuSyncService,
    mineruIngestService,
    maxSteps: finalConfig.maxSteps ?? 10,
    defaultModelConfig: finalConfig.defaultModelConfig ?? {
      provider: 'mock',
      model: 'mock-model',
      temperature: 0.7,
      maxTokens: 2000,
    },
    ...(finalConfig.planner?.llm ? { plannerModelConfig: finalConfig.planner.llm } : {}),
    persistLlmTokens: finalConfig.persistLlmTokens ?? false,
    workDir: finalConfig.workDir ?? `${finalConfig.baseDir}/workspace`,
    ...(finalConfig.mcp ? { mcp: finalConfig.mcp } : {}),
    runQueue,
  });
  runQueue.setExecutor(runtimeExecutor.execute);

  // Middleware: CORS
  app.use(
    cors({
      origin: finalConfig.corsOrigins,
      credentials: true,
    })
  );

  // Middleware: JSON body parser
  app.use(express.json());

  // Middleware: Request logging
  app.use((req: Request, _res: Response, next: NextFunction) => {
    logger.info('Request received', {
      method: req.method,
      path: req.path,
      query: req.query,
    });
    next();
  });

  // Health check endpoint
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      queue: {
        length: runQueue.getQueueLength(),
        processing: runQueue.isProcessing(),
      },
      sse: {
        clients: sseManager.getClientCount(),
      },
    });
  });

  // API routes
  const runsRouter = createRunsRouter({
    runQueue,
    sseManager,
    runRepository,
    eventService,
    checkpointService,
    approvalManager: runtimeExecutor.approvalManager,
  });
  app.use('/api', runsRouter);

  // Orchestrator API routes (Phase 0)
  const rolesRouter = createRolesRouter({ roleRepository });
  app.use('/api', rolesRouter);

  const groupsRouter = createGroupsRouter({ groupRepository, roleRepository, runRepository, runQueue });
  app.use('/api', groupsRouter);

  // Blackboard API routes (Phase 3)
  const blackboardRouter = createBlackboardRouter({ groupRepository, roleRepository, memoryService });
  app.use('/api', blackboardRouter);

  // Skills API routes (Phase 2)
  const skillsRouter = createSkillsRouter({ skillRepository });
  app.use('/api', skillsRouter);

  const feishuRouter = createFeishuConnectorsRouter({
    repository: feishuRepository,
    syncService: feishuSyncService,
  });
  app.use('/api', feishuRouter);
  const feishuImRouter = createFeishuImRouter({
    webhookHandler: feishuImService,
  });
  app.use('/api', feishuImRouter);

  // Uploads API routes
  const uploadService = new UploadService(finalConfig.baseDir);
  const uploadsRouter = createUploadsRouter({ uploadService });
  app.use('/api', uploadsRouter);

  // MinerU batch ingest API routes
  const mineruRouter = createMineruRouter({ mineruIngestService });
  app.use('/api', mineruRouter);

  // Error handling middleware
  app.use(errorHandler);

  // 404 handler
  app.use((_req: Request, res: Response) => {
    const response: ErrorResponse = {
      error: {
        code: 'NOT_FOUND',
        message: 'Endpoint not found',
      },
    };
    res.status(404).json(response);
  });

  return { app, runQueue, sseManager, dbReady, feishuSyncService };
}

/**
 * Error handling middleware
 */
function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  logger.error('Request error', {
    error: err.message,
    stack: err.stack,
  });

  if (err instanceof AgentError) {
    const response: ErrorResponse = {
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    };
    res.status(err.statusCode).json(response);
    return;
  }

  // Generic error response
  const response: ErrorResponse = {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An internal error occurred',
    },
  };
  res.status(500).json(response);
}

/**
 * Server instance wrapper for graceful shutdown
 */
export interface ServerInstance {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Create and start the server
 */
export function createServer(config: Partial<ServerConfig> = {}): ServerInstance {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  const { app, runQueue, sseManager, dbReady, feishuSyncService } = createApp(config);

  let server: ReturnType<typeof app.listen> | null = null;

  return {
    async start(): Promise<void> {
      await dbReady;
      // Restore pending runs from disk
      await runQueue.restore();
      return new Promise((resolve) => {
        // Start SSE heartbeat
        sseManager.startHeartbeat();
        feishuSyncService.start();

        server = app.listen(finalConfig.port, () => {
          logger.info('Server started', {
            port: finalConfig.port,
            baseDir: finalConfig.baseDir,
          });
          resolve();
        });
      });
    },

    async stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        // Stop SSE manager
        sseManager.shutdown();
        feishuSyncService.stop();

        // Clear queue
        runQueue.clearCompleted();

        if (server) {
          server.close((err) => {
            if (err) {
              reject(err);
            } else {
              void closeSharedPostgresPool()
                .then(() => {
                  logger.info('Server stopped');
                  resolve();
                })
                .catch(reject);
            }
          });
        } else {
          void closeSharedPostgresPool()
            .then(resolve)
            .catch(reject);
        }
      });
    },
  };
}

function resolveModulePath(entry: string): string {
  if (entry.startsWith('file://')) {
    return fileURLToPath(entry);
  }
  return path.resolve(entry);
}

// Main entry point when run directly
const isMainModule = (() => {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  const currentModulePath = fileURLToPath(import.meta.url);
  return resolveModulePath(entry) === currentModulePath;
})();

if (isMainModule) {
  const port = parseInt(process.env['PORT'] ?? '3000');
  const baseDir = process.env['DATA_DIR'] ?? 'data';
  const databaseUrl = process.env['DATABASE_URL'];

  const server = createServer({
    port,
    baseDir,
    ...(databaseUrl ? { databaseUrl } : {}),
  });

  // Graceful shutdown handlers
  process.on('SIGINT', () => {
    logger.info('Received SIGINT, shutting down...');
    void server.stop().then(() => process.exit(0));
  });

  process.on('SIGTERM', () => {
    logger.info('Received SIGTERM, shutting down...');
    void server.stop().then(() => process.exit(0));
  });

  void server.start();
}
