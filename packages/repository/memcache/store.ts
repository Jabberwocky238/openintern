import type { Event } from '@openintern/types/events.js';
import type { PlanRecord, PlanTaskRecord, RunDependency, RunRecord } from '../../../src/backend/runtime/models.js';
import type { Group, GroupMember, Role } from '@openintern/types/orchestrator.js';
import type { Skill } from '@openintern/types/skill.js';
import type { PluginJobRowView, PluginKvRowView, PluginRowView } from '../interfaces/plugin-repository.js';
import type { RunMessageRecord } from '../interfaces/run-repository.js';
import type { MemoryType } from '@openintern/types/memory.js';

export interface StoredEvent {
  id: number;
  event: Event;
}

export interface StoredCheckpoint {
  id: number;
  runId: string;
  agentId: string;
  stepId: string;
  state: Record<string, unknown>;
}

export interface StoredRunMessage {
  runId: string;
  agentId: string;
  stepId: string;
  ordinal: number;
  message: RunMessageRecord;
}

export interface StoredMemory {
  id: string;
  org_id: string;
  user_id: string;
  project_id: string | null;
  group_id: string | null;
  agent_instance_id: string | null;
  type: MemoryType;
  text: string;
  metadata: Record<string, unknown>;
  importance: number;
  created_at: string;
  updated_at: string;
}

export class MemoryRepositoryStore {
  public roles = new Map<string, Role>();
  public groups = new Map<string, Group>();
  public groupMembers = new Map<string, GroupMember>();
  public agentRoleByInstance = new Map<string, string>();
  public skills = new Map<string, Skill>();
  public runs = new Map<string, RunRecord>();
  public events: StoredEvent[] = [];
  public checkpoints: StoredCheckpoint[] = [];
  public runMessages: StoredRunMessage[] = [];
  public runDependencies: RunDependency[] = [];
  public plansByRunId = new Map<string, PlanRecord>();
  public planTasksByRunId = new Map<string, PlanTaskRecord[]>();
  public plugins = new Map<string, PluginRowView>();
  public pluginJobs = new Map<string, PluginJobRowView>();
  public pluginKv = new Map<string, PluginKvRowView>();
  public memories = new Map<string, StoredMemory>();

  public nextEventId = 1;
  public nextCheckpointId = 1;
  public nextDependencyId = 1;
  public nextPlanId = 1;
  public nextPlanTaskId = 1;
}

export const defaultMemoryRepositoryStore = new MemoryRepositoryStore();

export function resolveMemoryRepositoryStore(candidate?: unknown): MemoryRepositoryStore {
  return candidate instanceof MemoryRepositoryStore ? candidate : defaultMemoryRepositoryStore;
}

