/**
 * Groups API - Group and member management endpoints
 *
 * Endpoints:
 * - POST /api/groups
 * - GET /api/groups
 * - GET /api/groups/:group_id
 * - PUT /api/groups/:group_id
 * - DELETE /api/groups/:group_id
 * - GET /api/groups/:group_id/stats
 * - GET /api/groups/:group_id/runs
 * - POST /api/groups/:group_id/members
 * - GET /api/groups/:group_id/members
 * - PUT /api/groups/:group_id/members/:member_id
 * - DELETE /api/groups/:group_id/members/:member_id
 * - POST /api/groups/:group_id/runs (create run)
 * - POST /api/groups/batch-delete
 * - POST /api/groups/assign-project
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { QueuedRun } from '@openintern/types/api.js';
import { LLMConfigRequestSchema } from '@openintern/types/api.js';
import { CreateGroupSchema, AddMemberSchema } from '@openintern/types/orchestrator.js';
import { AgentError, NotFoundError, ValidationError } from '@openintern/utils';
import { generateRunId } from '@openintern/utils';
import { logger } from '@openintern/utils';
import type { IGroupRepository } from '@openintern/repository';
import { resolveRequestScope } from '../runtime/request-scope.js';
import type { IRoleRepository } from '@openintern/repository';
import type { IRunRepository } from '@openintern/repository';
import { RunQueue } from '../queue/run-queue.js';

export interface GroupsRouterConfig {
  groupRepository: IGroupRepository;
  roleRepository: IRoleRepository;
  runRepository: IRunRepository;
  runQueue: RunQueue;
}

const GroupRunRequestSchema = z.object({
  input: z.string().min(1),
  session_key: z.string().regex(/^s_[a-zA-Z0-9_]+$/).optional(),
  llm_config: LLMConfigRequestSchema,
});

const AssignProjectRequestSchema = z.object({
  project_id: z.string().min(1),
  include_existing: z.boolean().optional(),
});

export function createGroupsRouter(config: GroupsRouterConfig): Router {
  const router = Router();
  const { groupRepository, roleRepository, runRepository, runQueue } = config;

  // POST /api/groups
  router.post('/groups', (req: Request, res: Response) => {
    void (async () => {
      try {
        const parseResult = CreateGroupSchema.safeParse(req.body);
        if (!parseResult.success) {
          const firstError = parseResult.error.errors[0];
          throw new ValidationError(
            firstError?.message ?? 'Invalid request',
            firstError?.path.join('.') ?? 'body'
          );
        }
        const group = await groupRepository.createGroup(parseResult.data);
        logger.info('Group created', { groupId: group.id });
        res.status(201).json(group);
      } catch (err) {
        handleError(res, err);
      }
    })();
  });

  // GET /api/groups
  router.get('/groups', (req: Request, res: Response) => {
    void (async () => {
      try {
        const projectId = req.query.project_id as string | undefined;
        const groups = await groupRepository.listGroups(projectId);
        res.json({ groups });
      } catch (err) {
        handleError(res, err);
      }
    })();
  });

  // POST /api/groups/assign-project
  router.post('/groups/assign-project', (req: Request, res: Response) => {
    void (async () => {
      try {
        const parseResult = AssignProjectRequestSchema.safeParse(req.body);
        if (!parseResult.success) {
          const firstError = parseResult.error.errors[0];
          throw new ValidationError(
            firstError?.message ?? 'Invalid request',
            firstError?.path.join('.') ?? 'body'
          );
        }
        const projectId = parseResult.data.project_id.trim();
        const includeExisting = parseResult.data.include_existing ?? false;
        const updated = await groupRepository.assignProjectId(projectId, includeExisting);
        logger.info('Group project assigned', { projectId, includeExisting, updated });
        res.json({ project_id: projectId, include_existing: includeExisting, updated });
      } catch (err) {
        handleError(res, err);
      }
    })();
  });

  // GET /api/groups/:group_id
  router.get('/groups/:group_id', (req: Request, res: Response) => {
    void (async () => {
      try {
        const group = await groupRepository.requireGroup(req.params.group_id!);
        res.json(group);
      } catch (err) {
        handleError(res, err);
      }
    })();
  });

  // POST /api/groups/:group_id/members
  router.post('/groups/:group_id/members', (req: Request, res: Response) => {
    void (async () => {
      try {
        const parseResult = AddMemberSchema.safeParse(req.body);
        if (!parseResult.success) {
          const firstError = parseResult.error.errors[0];
          throw new ValidationError(
            firstError?.message ?? 'Invalid request',
            firstError?.path.join('.') ?? 'body'
          );
        }
        await roleRepository.require(parseResult.data.role_id);
        const member = await groupRepository.addMember(
          req.params.group_id!,
          parseResult.data
        );
        logger.info('Member added to group', {
          groupId: req.params.group_id,
          roleId: parseResult.data.role_id,
        });
        res.status(201).json(member);
      } catch (err) {
        handleError(res, err);
      }
    })();
  });

  // GET /api/groups/:group_id/members
  router.get('/groups/:group_id/members', (req: Request, res: Response) => {
    void (async () => {
      try {
        await groupRepository.requireGroup(req.params.group_id!);
        const members = await groupRepository.listMembers(req.params.group_id!);
        res.json({ members });
      } catch (err) {
        handleError(res, err);
      }
    })();
  });

  // PUT /api/groups/:group_id
  router.put('/groups/:group_id', (req: Request, res: Response) => {
    void (async () => {
      try {
        const parseResult = CreateGroupSchema.partial().safeParse(req.body);
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
          ...(parseResult.data.project_id !== undefined
            ? { project_id: parseResult.data.project_id }
            : {}),
        };
        const group = await groupRepository.updateGroup(req.params.group_id!, updates);
        logger.info('Group updated', { groupId: group.id });
        res.json(group);
      } catch (err) {
        handleError(res, err);
      }
    })();
  });

  // DELETE /api/groups/:group_id
  router.delete('/groups/:group_id', (req: Request, res: Response) => {
    void (async () => {
      try {
        const deleted = await groupRepository.deleteGroup(req.params.group_id!);
        if (!deleted) {
          throw new NotFoundError('Group', req.params.group_id!);
        }
        logger.info('Group deleted', { groupId: req.params.group_id });
        res.status(204).send();
      } catch (err) {
        handleError(res, err);
      }
    })();
  });

  // GET /api/groups/:group_id/stats
  router.get('/groups/:group_id/stats', (req: Request, res: Response) => {
    void (async () => {
      try {
        const stats = await groupRepository.getGroupStats(req.params.group_id!);
        res.json(stats);
      } catch (err) {
        handleError(res, err);
      }
    })();
  });

  // GET /api/groups/:group_id/runs (history)
  router.get('/groups/:group_id/runs', (req: Request, res: Response) => {
    void (async () => {
      try {
        const limit = Math.min(Number.parseInt(req.query.limit as string || '20', 10), 100);
        const offset = Number.parseInt(req.query.offset as string || '0', 10);
        const runs = await groupRepository.getGroupRuns(req.params.group_id!, limit, offset);
        res.json({ runs });
      } catch (err) {
        handleError(res, err);
      }
    })();
  });

  // PUT /api/groups/:group_id/members/:member_id
  router.put('/groups/:group_id/members/:member_id', (req: Request, res: Response) => {
    void (async () => {
      try {
        const { ordinal } = req.body as { ordinal?: number };
        const updates = ordinal !== undefined ? { ordinal } : {};
        const member = await groupRepository.updateMember(
          req.params.group_id!,
          req.params.member_id!,
          updates
        );
        logger.info('Member updated', {
          groupId: req.params.group_id,
          memberId: req.params.member_id,
        });
        res.json(member);
      } catch (err) {
        handleError(res, err);
      }
    })();
  });

  // DELETE /api/groups/:group_id/members/:member_id
  router.delete('/groups/:group_id/members/:member_id', (req: Request, res: Response) => {
    void (async () => {
      try {
        const deleted = await groupRepository.removeMember(
          req.params.group_id!,
          req.params.member_id!
        );
        if (!deleted) {
          throw new NotFoundError('GroupMember', req.params.member_id!);
        }
        logger.info('Member removed from group', {
          groupId: req.params.group_id,
          memberId: req.params.member_id,
        });
        res.status(204).send();
      } catch (err) {
        handleError(res, err);
      }
    })();
  });

  // POST /api/groups/batch-delete
  router.post('/groups/batch-delete', (req: Request, res: Response) => {
    void (async () => {
      try {
        const { ids } = req.body as { ids?: string[] };
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
          throw new ValidationError('ids array is required', 'ids');
        }
        let deletedCount = 0;
        for (const id of ids) {
          const deleted = await groupRepository.deleteGroup(id);
          if (deleted) deletedCount++;
        }
        logger.info('Groups batch deleted', { count: deletedCount });
        res.json({ deleted: deletedCount });
      } catch (err) {
        handleError(res, err);
      }
    })();
  });

  // POST /api/groups/:group_id/runs
  router.post('/groups/:group_id/runs', (req: Request, res: Response) => {
    void (async () => {
      try {
        const groupId = req.params.group_id!;
        await groupRepository.requireGroup(groupId);

        const members = await groupRepository.listMembers(groupId);
        if (members.length === 0) {
          throw new ValidationError('Group has no members', 'group_id');
        }

        const parseResult = GroupRunRequestSchema.safeParse(req.body);
        if (!parseResult.success) {
          const firstError = parseResult.error.errors[0];
          throw new ValidationError(
            firstError?.message ?? 'Invalid request',
            firstError?.path.join('.') ?? 'body'
          );
        }
        const { input, session_key, llm_config } = parseResult.data;

        const scope = resolveRequestScope(req);
        const runId = generateRunId();
        const sessionKey = session_key ?? 's_default';
        const agentId = `group:${groupId}`;

        const created = await runRepository.createRun({
          id: runId,
          scope,
          sessionKey,
          input,
          agentId,
          runMode: 'group',
          groupId,
          llmConfig: llm_config ?? null,
        });

        const queuedRun: QueuedRun = {
          run_id: created.id,
          org_id: created.orgId,
          user_id: created.userId,
          ...(created.projectId ? { project_id: created.projectId } : {}),
          session_key: created.sessionKey,
          input: created.input,
          agent_id: created.agentId,
          run_mode: created.runMode,
          created_at: created.createdAt,
          status: 'pending',
          llm_config: created.llmConfig ?? undefined,
          group_id: created.groupId ?? groupId,
        };
        runQueue.enqueue(queuedRun);

        logger.info('Group run created', {
          groupId,
          runId: created.id,
          memberCount: members.length,
        });

        res.status(201).json({
          run_id: created.id,
          group_id: groupId,
          status: created.status,
          created_at: created.createdAt,
        });
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
  logger.error('Groups API error', { err: String(err) });
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message },
  });
}







