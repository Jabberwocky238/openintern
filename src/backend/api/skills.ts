/**
 * Skills API - Skill registry CRUD endpoints
 *
 * Endpoints:
 * - POST /api/skills
 * - GET /api/skills
 * - GET /api/skills/:skill_id
 * - DELETE /api/skills/:skill_id
 */

import { Router, type Request, type Response } from 'express';
import { CreateSkillSchema } from '../../types/skill.js';
import { AgentError, ValidationError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import type { ISkillRepository } from '@openintern/repository';

export interface SkillsRouterConfig {
  skillRepository: ISkillRepository;
}

export function createSkillsRouter(config: SkillsRouterConfig): Router {
  const router = Router();
  const { skillRepository } = config;

  // POST /api/skills
  router.post('/skills', (req: Request, res: Response) => {
    void (async () => {
      try {
        const parseResult = CreateSkillSchema.safeParse(req.body);
        if (!parseResult.success) {
          const firstError = parseResult.error.errors[0];
          throw new ValidationError(
            firstError?.message ?? 'Invalid request',
            firstError?.path.join('.') ?? 'body'
          );
        }

        const skill = await skillRepository.create(parseResult.data);
        logger.info('Skill created', { skillId: skill.id });
        res.status(201).json(skill);
      } catch (err) {
        handleError(res, err);
      }
    })();
  });

  // GET /api/skills
  router.get('/skills', (_req: Request, res: Response) => {
    void (async () => {
      try {
        const skills = await skillRepository.list();
        res.json({ skills });
      } catch (err) {
        handleError(res, err);
      }
    })();
  });

  // GET /api/skills/:skill_id
  router.get('/skills/:skill_id', (req: Request, res: Response) => {
    void (async () => {
      try {
        const skill = await skillRepository.require(req.params.skill_id!);
        res.json(skill);
      } catch (err) {
        handleError(res, err);
      }
    })();
  });

  // DELETE /api/skills/:skill_id
  router.delete('/skills/:skill_id', (req: Request, res: Response) => {
    void (async () => {
      try {
        const deleted = await skillRepository.delete(req.params.skill_id!);
        if (!deleted) {
          res.status(404).json({
            error: { code: 'NOT_FOUND', message: 'Skill not found' },
          });
          return;
        }
        res.status(204).send();
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
  logger.error('Skills API error', { err: String(err) });
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message },
  });
}







