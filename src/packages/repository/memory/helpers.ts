import type { ScopeContext } from '../../shared/scope.js';

export function nowIso(): string {
  return new Date().toISOString();
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function sameNullable(left: string | null, right: string | null): boolean {
  return left === right;
}

export function matchesScope(
  scope: ScopeContext,
  target: { orgId: string; userId: string; projectId: string | null }
): boolean {
  return (
    scope.orgId === target.orgId &&
    scope.userId === target.userId &&
    sameNullable(scope.projectId, target.projectId)
  );
}

export function durationMs(startedAt: string | null, endedAt: string | null): number | null {
  if (!startedAt || !endedAt) {
    return null;
  }
  return new Date(endedAt).getTime() - new Date(startedAt).getTime();
}


