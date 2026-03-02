import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '@openintern/types/agent.js';
import type { ScopeContext } from '../scope.js';
import type { AgentContext } from '../tool-policy.js';
import type { MemoryService } from '../memory-service.js';
import type { EventService } from '../event-service.js';
import type { FeishuSyncService } from '../integrations/feishu/sync-service.js';
import type { MineruIngestService } from '../integrations/mineru/ingest-service.js';
import type { SkillRegistry } from '../skill/registry.js';
import type { EscalationService } from '../escalation-service.js';
import type { IGroupRepository } from '@openintern/repository';
import type { IRunRepository } from '@openintern/repository';
import type { IRoleRepository } from '@openintern/repository';
import { ToolError } from '@openintern/utils';

export type ToolHandler = (params: Record<string, unknown>) => Promise<unknown>;

export interface RuntimeTool extends ToolDefinition {
  handler: ToolHandler;
  source: 'builtin' | 'mcp';
  metadata?: ToolDefinition['metadata'];
}

/** Shared mutable context passed to all tool modules. */
export interface ToolContext {
  memoryService: MemoryService;
  eventService: EventService;
  feishuSyncService: FeishuSyncService | undefined;
  mineruIngestService: MineruIngestService | undefined;
  workDir: string;
  escalationService: EscalationService | undefined;
  groupRepository: IGroupRepository | undefined;
  runRepository: IRunRepository | undefined;
  roleRepository: IRoleRepository | undefined;
  runQueue: { enqueue(runId: string): Promise<void> | void } | undefined;
  skillRegistry: SkillRegistry | null;
  scope: ScopeContext;
  currentRunId: string | null;
  currentSessionKey: string | null;
  currentAgentContext: AgentContext | null;
}

export function extractString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function extractBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  return null;
}

export function extractNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function resolveWithinWorkDir(workDir: string, requestedPath: string, toolName = 'file'): string {
  const absoluteWorkDir = path.resolve(workDir);
  const resolvedPath = path.resolve(absoluteWorkDir, requestedPath);
  if (!resolvedPath.startsWith(`${absoluteWorkDir}${path.sep}`) && resolvedPath !== absoluteWorkDir) {
    throw new ToolError('Path escapes working directory', toolName);
  }
  return resolvedPath;
}







