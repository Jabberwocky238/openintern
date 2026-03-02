import type { Event } from '../../../types/events.js';
import type { PlanRecord, PlanTaskRecord, RunDependency, RunRecord } from '../../../backend/runtime/models.js';
import type { Group, GroupMember, Role } from '../../../types/orchestrator.js';
import type { Skill } from '../../../types/skill.js';
import type { PluginJobRowView, PluginKvRowView, PluginRowView } from '../interfaces/plugin-repository.js';
import type { RunMessageRecord } from '../interfaces/run-repository.js';

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

