export type { IRunRepository, RunMessageRecord } from './interfaces/run-repository.js';
export type {
  IPostgresClient,
  IPostgresPool,
  IPostgresQueryable,
  PostgresQueryResult,
} from './interfaces/postgres-client.js';
export type { IRoleRepository } from './interfaces/role-repository.js';
export type {
  IGroupRepository,
  GroupRunRecord,
  GroupRoleMemberView,
  GroupWithRolesView,
} from './interfaces/group-repository.js';
export type { ISkillRepository } from './interfaces/skill-repository.js';
export type {
  IPlanRepository,
  CreatePlanInput,
  CreatePlanTaskInput,
  TaskDispatchInput,
} from './interfaces/plan-repository.js';
export type {
  IPluginRepository,
  CreatePluginInput,
  CreatePluginJobInput,
  PluginRowView,
  PluginJobRowView,
  PluginKvRowView,
} from './interfaces/plugin-repository.js';
export type {
  IFeishuRepository,
  FeishuScope,
  FeishuSourceStateView,
  CreateFeishuConnectorInput,
  UpdateFeishuConnectorInput,
  UpdateFeishuConnectorSyncResultInput,
  CreateFeishuSyncJobInput,
  UpsertFeishuSourceStateInput,
} from './interfaces/feishu-repository.js';
export type {
  IMemoryRepository,
  MemorySearchInput,
  MemoryWriteRequestRepo,
  ReplaceArchivalDocumentInput,
} from './interfaces/memory-repository.js';
import { logger } from '@openintern/utils';
import type { IPostgresPool } from './interfaces/postgres-client.js';

import * as memoryRepository from './memcache/index.js';
import * as postgresRepository from './postgres/index.js';

type RepositoryDevType = 'memory' | 'postgres';
type RepositoryModule = {
  RunRepository: new (...args: any[]) => import('./interfaces/run-repository.js').IRunRepository;
  RoleRepository: new (...args: any[]) => import('./interfaces/role-repository.js').IRoleRepository;
  GroupRepository: new (...args: any[]) => import('./interfaces/group-repository.js').IGroupRepository;
  PlanRepository: new (...args: any[]) => import('./interfaces/plan-repository.js').IPlanRepository;
  SkillRepository: new (...args: any[]) => import('./interfaces/skill-repository.js').ISkillRepository;
  PluginRepository: new (...args: any[]) => import('./interfaces/plugin-repository.js').IPluginRepository;
  FeishuRepository: new (...args: any[]) => import('./interfaces/feishu-repository.js').IFeishuRepository;
  MemoryRepository: new (...args: any[]) => import('./interfaces/memory-repository.js').IMemoryRepository;
};

const repositoryDevType: RepositoryDevType =
  process.env['OPENINTERN_REPOSITORY_DEV_TYPE'] === 'postgres' ? 'postgres' : 'memory';

const selectedRepository: RepositoryModule =
  repositoryDevType === 'postgres' ? postgresRepository : memoryRepository;

export const OPENINTERN_REPOSITORY_DEV_TYPE = repositoryDevType;
export default selectedRepository;

const MEMORY_MODE_MIGRATION_WARNING =
  'Repository mode is memory; skipping Postgres migrations.';

export async function runPostgresMigrations(pool?: IPostgresPool): Promise<void> {
  if (repositoryDevType === 'memory') {
    logger.warn(MEMORY_MODE_MIGRATION_WARNING);
    return;
  }
  const targetPool = pool ?? postgresRepository.getPostgresPool();
  await postgresRepository.runPostgresMigrations(targetPool);
}

export const {
  RunRepository,
  RoleRepository,
  GroupRepository,
  PlanRepository,
  SkillRepository,
  PluginRepository,
  FeishuRepository,
  MemoryRepository,
} = selectedRepository;

export type RunRepository = import('./interfaces/run-repository.js').IRunRepository;
export type RoleRepository = import('./interfaces/role-repository.js').IRoleRepository;
export type GroupRepository = import('./interfaces/group-repository.js').IGroupRepository;
export type GroupRoleMember = import('./interfaces/group-repository.js').GroupRoleMemberView;
export type GroupWithRoles = import('./interfaces/group-repository.js').GroupWithRolesView;
export type PlanRepository = import('./interfaces/plan-repository.js').IPlanRepository;
export type SkillRepository = import('./interfaces/skill-repository.js').ISkillRepository;
export type PluginRepository = import('./interfaces/plugin-repository.js').IPluginRepository;
export type PluginRow = import('./interfaces/plugin-repository.js').PluginRowView;
export type PluginJobRow = import('./interfaces/plugin-repository.js').PluginJobRowView;
export type PluginKvRow = import('./interfaces/plugin-repository.js').PluginKvRowView;
export type FeishuRepository = import('./interfaces/feishu-repository.js').IFeishuRepository;
export type MemoryRepository = import('./interfaces/memory-repository.js').IMemoryRepository;
export type FeishuSourceState = import('./interfaces/feishu-repository.js').FeishuSourceStateView;
