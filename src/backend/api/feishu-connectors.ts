import { Router, type Request, type Response } from 'express';
import {
  CreateFeishuConnectorRequestSchema,
  TriggerFeishuSyncRequestSchema,
  UpdateFeishuConnectorRequestSchema,
  type FeishuConnectorConfig,
  type FeishuConnectorStatus,
} from '../../types/feishu.js';
import { AgentError, ValidationError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { resolveRequestScope } from '../runtime/request-scope.js';
import type { IFeishuRepository } from '@openintern/repository';
import { FeishuSyncService } from '../runtime/integrations/feishu/sync-service.js';

export interface FeishuConnectorsRouterConfig {
  repository: IFeishuRepository;
  syncService: FeishuSyncService;
}

interface RequiredProjectScope {
  orgId: string;
  userId: string;
  projectId: string;
}

function requireProjectScope(req: Request): RequiredProjectScope {
  const scope = resolveRequestScope(req);
  if (!scope.projectId) {
    throw new ValidationError('project_id is required for Feishu connector APIs', 'project_id');
  }
  return {
    orgId: scope.orgId,
    userId: scope.userId,
    projectId: scope.projectId,
  };
}

function handleError(res: Response, err: unknown): void {
  if (err instanceof AgentError) {
    res.status(err.statusCode).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  const message = err instanceof Error ? err.message : 'Internal server error';
  logger.error('Feishu connectors API error', {
    error: message,
  });
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message },
  });
}

function toStatus(value: FeishuConnectorStatus | undefined): FeishuConnectorStatus {
  return value ?? 'active';
}

export function createFeishuConnectorsRouter(config: FeishuConnectorsRouterConfig): Router {
  const router = Router();
  const { repository, syncService } = config;

  // POST /api/feishu/connectors
  router.post('/feishu/connectors', (req: Request, res: Response) => {
    void (async () => {
      try {
        const scope = requireProjectScope(req);
        const parsed = CreateFeishuConnectorRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          const first = parsed.error.errors[0];
          throw new ValidationError(
            first?.message ?? 'Invalid request',
            first?.path.join('.') ?? 'body'
          );
        }

        const connector = await repository.createConnector({
          orgId: scope.orgId,
          projectId: scope.projectId,
          createdBy: scope.userId,
          name: parsed.data.name,
          status: toStatus(parsed.data.status),
          config: parsed.data.config,
        });
        res.status(201).json(connector);
      } catch (err) {
        handleError(res, err);
      }
    })();
  });

  // GET /api/feishu/connectors
  router.get('/feishu/connectors', (req: Request, res: Response) => {
    void (async () => {
      try {
        const scope = requireProjectScope(req);
        const connectors = await repository.listConnectors({
          orgId: scope.orgId,
          projectId: scope.projectId,
        });
        res.json({ connectors });
      } catch (err) {
        handleError(res, err);
      }
    })();
  });

  // GET /api/feishu/connectors/:connector_id
  router.get('/feishu/connectors/:connector_id', (req: Request, res: Response) => {
    void (async () => {
      try {
        const scope = requireProjectScope(req);
        const connector = await repository.requireConnector(
          { orgId: scope.orgId, projectId: scope.projectId },
          req.params.connector_id!
        );
        res.json(connector);
      } catch (err) {
        handleError(res, err);
      }
    })();
  });

  // PATCH /api/feishu/connectors/:connector_id
  router.patch('/feishu/connectors/:connector_id', (req: Request, res: Response) => {
    void (async () => {
      try {
        const scope = requireProjectScope(req);
        const parsed = UpdateFeishuConnectorRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          const first = parsed.error.errors[0];
          throw new ValidationError(
            first?.message ?? 'Invalid request',
            first?.path.join('.') ?? 'body'
          );
        }
        const patch: {
          name?: string;
          status?: FeishuConnectorStatus;
          config?: FeishuConnectorConfig;
        } = {};
        if (parsed.data.name !== undefined) {
          patch.name = parsed.data.name;
        }
        if (parsed.data.status !== undefined) {
          patch.status = parsed.data.status;
        }
        if (parsed.data.config !== undefined) {
          patch.config = parsed.data.config;
        }
        const updated = await repository.updateConnector(
          { orgId: scope.orgId, projectId: scope.projectId },
          req.params.connector_id!,
          patch
        );
        res.json(updated);
      } catch (err) {
        handleError(res, err);
      }
    })();
  });

  // POST /api/feishu/connectors/:connector_id/sync
  router.post('/feishu/connectors/:connector_id/sync', (req: Request, res: Response) => {
    void (async () => {
      try {
        const scope = requireProjectScope(req);
        const parsed = TriggerFeishuSyncRequestSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          const first = parsed.error.errors[0];
          throw new ValidationError(
            first?.message ?? 'Invalid request',
            first?.path.join('.') ?? 'body'
          );
        }

        const job = await syncService.triggerSync(
          { orgId: scope.orgId, projectId: scope.projectId },
          req.params.connector_id!,
          {
            trigger: 'manual',
            wait: parsed.data.wait,
          }
        );
        res.status(202).json(job);
      } catch (err) {
        handleError(res, err);
      }
    })();
  });

  // GET /api/feishu/connectors/:connector_id/jobs?limit=20
  router.get('/feishu/connectors/:connector_id/jobs', (req: Request, res: Response) => {
    void (async () => {
      try {
        const scope = requireProjectScope(req);
        const rawLimit = Number.parseInt(String(req.query.limit ?? '20'), 10);
        const limit = Number.isFinite(rawLimit)
          ? Math.max(1, Math.min(rawLimit, 100))
          : 20;
        const jobs = await repository.listSyncJobs(
          { orgId: scope.orgId, projectId: scope.projectId },
          req.params.connector_id!,
          limit
        );
        res.json({ jobs });
      } catch (err) {
        handleError(res, err);
      }
    })();
  });

  return router;
}





