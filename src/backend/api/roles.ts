/**
 * Roles API - Role template CRUD endpoints
 *
 * Endpoints:
 * - POST /api/roles
 * - GET /api/roles
 * - GET /api/roles/:role_id
 * - PUT /api/roles/:role_id
 * - DELETE /api/roles/:role_id
 */

import { Router, type Request, type Response } from 'express';
import { CreateRoleSchema } from '../../types/orchestrator.js';
import { AgentError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { RoleRepository } from '../repository/postgres/role-repository.js';

export interface RolesRouterConfig {
  roleRepository: RoleRepository;
}

export function createRolesRouter(config: RolesRouterConfig): Router {
  const router = Router();
  const { roleRepository } = config;

  // POST /api/roles
  router.post('/roles', (req: Request, res: Response) => {
    void (async () => {
      try {
        const parseResult = CreateRoleSchema.safeParse(req.body);
        if (!parseResult.success) {
          const firstError = parseResult.error.errors[0];
          throw new ValidationError(
            firstError?.message ?? 'Invalid request',
            firstError?.path.join('.') ?? 'body'
          );
        }

        const role = await roleRepository.create(parseResult.data);
        logger.info('Role created', { roleId: role.id });
        res.status(201).json(role);
      } catch (err) {
        handleError(res, err);
      }
    })();
  });

  // GET /api/roles
  router.get('/roles', (_req: Request, res: Response) => {
    void (async () => {
      try {
        const roles = await roleRepository.list();
        res.json({ roles });
      } catch (err) {
        handleError(res, err);
      }
    })();
  });

  // GET /api/roles/:role_id
  router.get('/roles/:role_id', (req: Request, res: Response) => {
    void (async () => {
      try {
        const role = await roleRepository.require(req.params.role_id!);
        res.json(role);
      } catch (err) {
        handleError(res, err);
      }
    })();
  });

  // PUT /api/roles/:role_id
  router.put('/roles/:role_id', (req: Request, res: Response) => {
    void (async () => {
      try {
        const parseResult = CreateRoleSchema.partial().safeParse(req.body);
        if (!parseResult.success) {
          const firstError = parseResult.error.errors[0];
          throw new ValidationError(
            firstError?.message ?? 'Invalid request',
            firstError?.path.join('.') ?? 'body'
          );
        }
        const updates = {
          ...(parseResult.data.name !== undefined ? { name: parseResult.data.name } : {}),
          ...(parseResult.data.description !== undefined
            ? { description: parseResult.data.description }
            : {}),
          ...(parseResult.data.system_prompt !== undefined
            ? { system_prompt: parseResult.data.system_prompt }
            : {}),
          ...(parseResult.data.allowed_tools !== undefined
            ? { allowed_tools: parseResult.data.allowed_tools }
            : {}),
          ...(parseResult.data.denied_tools !== undefined
            ? { denied_tools: parseResult.data.denied_tools }
            : {}),
          ...(parseResult.data.style_constraints !== undefined
            ? { style_constraints: parseResult.data.style_constraints }
            : {}),
          ...(parseResult.data.is_lead !== undefined ? { is_lead: parseResult.data.is_lead } : {}),
        };
        const role = await roleRepository.update(req.params.role_id!, updates);
        logger.info('Role updated', { roleId: role.id });
        res.json(role);
      } catch (err) {
        handleError(res, err);
      }
    })();
  });

  // DELETE /api/roles/:role_id
  router.delete('/roles/:role_id', (req: Request, res: Response) => {
    void (async () => {
      try {
        const deleted = await roleRepository.delete(req.params.role_id!);
        if (!deleted) {
          throw new NotFoundError('Role', req.params.role_id!);
        }
        logger.info('Role deleted', { roleId: req.params.role_id });
        res.status(204).send();
      } catch (err) {
        handleError(res, err);
      }
    })();
  });

  // GET /api/roles/:role_id/stats
  router.get('/roles/:role_id/stats', (req: Request, res: Response) => {
    void (async () => {
      try {
        const stats = await roleRepository.getStats(req.params.role_id!);
        res.json(stats);
      } catch (err) {
        handleError(res, err);
      }
    })();
  });

  // POST /api/roles/batch-delete
  router.post('/roles/batch-delete', (req: Request, res: Response) => {
    void (async () => {
      try {
        const { ids } = req.body as { ids?: string[] };
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
          throw new ValidationError('ids array is required', 'ids');
        }
        let deletedCount = 0;
        for (const id of ids) {
          const deleted = await roleRepository.delete(id);
          if (deleted) deletedCount++;
        }
        logger.info('Roles batch deleted', { count: deletedCount });
        res.json({ deleted: deletedCount });
      } catch (err) {
        handleError(res, err);
      }
    })();
  });

  return router;
}

function handleError(res: Response, err: unknown): void {
  if (err instanceof AgentError) {
    res.status(err.statusCode).json({
      error: { code: err.code, message: err.message },
    });
    return;
  }
  const message = err instanceof Error ? err.message : 'Internal server error';
  logger.error('Roles API error', { err: String(err) });
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message },
  });
}
