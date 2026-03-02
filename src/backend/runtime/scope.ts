import type { Scope } from '@openintern/types/scope.js';
import type { MemoryScope } from '@openintern/types/memory.js';

export interface ScopeContext {
  orgId: string;
  userId: string;
  projectId: string | null;
}

export interface MemoryScopeContext extends ScopeContext {
  groupId: string | null;
  agentInstanceId: string | null;
}

export function toScopeContext(scope: Scope): ScopeContext {
  return {
    orgId: scope.org_id,
    userId: scope.user_id,
    projectId: scope.project_id ?? null,
  };
}

export function appendScopePredicate(
  clauses: string[],
  params: unknown[],
  scope: ScopeContext,
  alias?: string
): void {
  const prefix = alias ? `${alias}.` : '';
  const orgIndex = params.push(scope.orgId);
  const userIndex = params.push(scope.userId);
  const projectIndex = params.push(scope.projectId);
  clauses.push(`${prefix}org_id = $${orgIndex}`);
  clauses.push(`${prefix}user_id = $${userIndex}`);
  clauses.push(`${prefix}project_id IS NOT DISTINCT FROM $${projectIndex}`);
}

export function toMemoryScopeContext(scope: MemoryScope): MemoryScopeContext {
  return {
    orgId: scope.org_id,
    userId: scope.user_id,
    projectId: scope.project_id ?? null,
    groupId: scope.group_id ?? null,
    agentInstanceId: scope.agent_instance_id ?? null,
  };
}

/**
 * Append memory-specific scope predicates.
 * Extends the base scope with optional group_id and agent_instance_id filtering.
 */
export function appendMemoryScopePredicate(
  clauses: string[],
  params: unknown[],
  scope: MemoryScopeContext,
  alias?: string
): void {
  appendScopePredicate(clauses, params, scope, alias);
  const prefix = alias ? `${alias}.` : '';
  if (scope.groupId) {
    const idx = params.push(scope.groupId);
    clauses.push(`${prefix}group_id = $${idx}`);
  }
  if (scope.agentInstanceId) {
    const idx = params.push(scope.agentInstanceId);
    clauses.push(`${prefix}agent_instance_id = $${idx}`);
  }
}

