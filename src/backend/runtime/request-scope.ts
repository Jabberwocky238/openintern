import type { Request } from 'express';
import { ValidationError } from '@openintern/utils';
import type { ScopeContext } from './scope.js';

function readString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

export function resolveRequestScope(req: Request): ScopeContext {
  const body = typeof req.body === 'object' && req.body !== null
    ? (req.body as Record<string, unknown>)
    : {};

  const query = req.query as Record<string, unknown>;
  const orgId = readString(req.header('x-org-id')) ?? readString(body['org_id']) ?? readString(query['org_id']);
  const userId = readString(req.header('x-user-id')) ?? readString(body['user_id']) ?? readString(query['user_id']);
  const projectId =
    readString(req.header('x-project-id')) ??
    readString(body['project_id']) ??
    readString(query['project_id']) ??
    null;

  if (!orgId) {
    throw new ValidationError('org_id is required', 'org_id');
  }
  if (!userId) {
    throw new ValidationError('user_id is required', 'user_id');
  }

  return {
    orgId,
    userId,
    projectId,
  };
}

