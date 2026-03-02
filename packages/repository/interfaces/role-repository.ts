import type { CreateRole, Role } from '@openintern/types/orchestrator.js';

export interface IRoleRepository {
  create(input: CreateRole): Promise<Role>;
  getById(id: string): Promise<Role | null>;
  require(id: string): Promise<Role>;
  getRoleByAgentId(agentId: string): Promise<Role | null>;
  list(): Promise<Role[]>;
  update(id: string, fields: Partial<CreateRole>): Promise<Role>;
  delete(id: string): Promise<boolean>;
  getStats(id: string): Promise<{
    group_count: number;
    groups: Array<{ id: string; name: string }>;
  }>;
}

