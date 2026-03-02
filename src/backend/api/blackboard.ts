/**
 * Blackboard API - Group blackboard memory endpoints
 *
 * Endpoints:
 * - GET /api/groups/:groupId/blackboard
 * - GET /api/groups/:groupId/blackboard/:memoryId
 * - POST /api/groups/:groupId/blackboard
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { MemoryTypeSchema } from '@openintern/types/memory.js';
import { AgentError, ValidationError } from '@openintern/utils';
import { logger } from '@openintern/utils';
import type { IGroupRepository } from '@openintern/repository';
import { MemoryService } from '../runtime/memory-service.js';
import { resolveRequestScope } from '../runtime/request-scope.js';
import type { IRoleRepository } from '@openintern/repository';

export interface BlackboardRouterConfig {
  groupRepository: IGroupRepository;
  roleRepository: IRoleRepository;
  memoryService: MemoryService;
}

const BlackboardWriteBodySchema = z.object({
  type: MemoryTypeSchema,
  text: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
  importance: z.number().min(0).max(1).optional(),
  role_id: z.string().min(1),
});

export function createBlackboardRouter(config: BlackboardRouterConfig): Router {
  const router = Router();
  const { groupRepository, roleRepository, memoryService } = config;

  // GET /api/groups/:groupId/blackboard
  router.get(
    '/groups/:groupId/blackboard',
    (req: Request, res: Response) => {
      void (async () => {
        try {
          const groupId = req.params.groupId!;
          await groupRepository.requireGroup(groupId);

          const scope = resolveRequestScope(req);
          const memories = await memoryService.blackboard_list(
            groupId,
            {
              org_id: scope.orgId,
              user_id: scope.userId,
              ...(scope.projectId ? { project_id: scope.projectId } : {}),
            }
          );

          res.json({ memories });
        } catch (err) {
          handleError(res, err);
        }
      })();
    }
  );

  // GET /api/groups/:groupId/blackboard/:memoryId
  router.get(
    '/groups/:groupId/blackboard/:memoryId',
    (req: Request, res: Response) => {
      void (async () => {
        try {
          const groupId = req.params.groupId!;
          const memoryId = req.params.memoryId!;
          await groupRepository.requireGroup(groupId);

          const scope = resolveRequestScope(req);
          const memory = await memoryService.memory_get(memoryId, {
            org_id: scope.orgId,
            user_id: scope.userId,
            ...(scope.projectId ? { project_id: scope.projectId } : {}),
          });

          if (!memory) {
            res.status(404).json({
              error: { code: 'NOT_FOUND', message: 'Memory not found' },
            });
            return;
          }

          res.json(memory);
        } catch (err) {
          handleError(res, err);
        }
      })();
    }
  );

  // POST /api/groups/:groupId/blackboard
  router.post(
    '/groups/:groupId/blackboard',
    (req: Request, res: Response) => {
      void (async () => {
        try {
          const groupId = req.params.groupId!;
          await groupRepository.requireGroup(groupId);

          const parseResult = BlackboardWriteBodySchema.safeParse(req.body);
          if (!parseResult.success) {
            const firstError = parseResult.error.errors[0];
            throw new ValidationError(
              firstError?.message ?? 'Invalid request',
              firstError?.path.join('.') ?? 'body'
            );
          }

          const { type, text, metadata, importance, role_id } = parseResult.data;

          // Resolve role to check is_lead
          const role = await roleRepository.require(role_id);

          const scope = resolveRequestScope(req);
          const result = await memoryService.blackboard_write({
            type,
            scope: {
              org_id: scope.orgId,
              user_id: scope.userId,
              ...(scope.projectId ? { project_id: scope.projectId } : {}),
            },
            group_id: groupId,
            text,
            metadata,
            importance,
            role_id,
            is_lead: role.is_lead,
          });

          logger.info('Blackboard memory written', {
            groupId,
            memoryId: result.id,
            type,
            roleId: role_id,
          });

          res.status(201).json(result);
        } catch (err) {
          handleError(res, err);
        }
      })();
    }
  );

  return router;
}

function handleError(res: Response, err: unknown): void {
  if (err instanceof AgentError) {
    res.status(err.statusCode).json({
      error: { code: err.code, message: err.message },
    });
    return;
  }
  if (err instanceof Error && err.message.includes('Only lead roles')) {
    res.status(403).json({
      error: { code: 'FORBIDDEN', message: err.message },
    });
    return;
  }
  const message = err instanceof Error ? err.message : 'Internal server error';
  logger.error('Blackboard API error', { err: String(err) });
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message },
  });
}







