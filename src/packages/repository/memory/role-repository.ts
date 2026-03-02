import type { CreateRole, Role } from '../../../types/orchestrator.js';
import { NotFoundError } from '@openintern/utils';
import { generateRoleId } from '@openintern/utils';
import type { IRoleRepository } from '../interfaces/role-repository.js';
import { clone, nowIso } from './helpers.js';
import { resolveMemoryRepositoryStore, type MemoryRepositoryStore } from './store.js';

export class RoleRepository implements IRoleRepository {
  private readonly store: MemoryRepositoryStore;

  constructor(storeOrPool?: unknown) {
    this.store = resolveMemoryRepositoryStore(storeOrPool);
  }

  async create(input: CreateRole): Promise<Role> {
    const now = nowIso();
    const role: Role = {
      id: generateRoleId(),
      name: input.name,
      description: input.description ?? '',
      system_prompt: input.system_prompt,
      allowed_tools: input.allowed_tools ?? [],
      denied_tools: input.denied_tools ?? [],
      style_constraints: input.style_constraints ?? {},
      is_lead: input.is_lead ?? false,
      created_at: now,
      updated_at: now,
    };
    this.store.roles.set(role.id, clone(role));
    return clone(role);
  }

  async getById(id: string): Promise<Role | null> {
    const role = this.store.roles.get(id);
    return role ? clone(role) : null;
  }

  async require(id: string): Promise<Role> {
    const role = await this.getById(id);
    if (!role) {
      throw new NotFoundError('Role', id);
    }
    return role;
  }

  async getRoleByAgentId(agentId: string): Promise<Role | null> {
    const roleId = this.store.agentRoleByInstance.get(agentId);
    if (!roleId) {
      return null;
    }
    return this.getById(roleId);
  }

  async list(): Promise<Role[]> {
    const roles = [...this.store.roles.values()];
    roles.sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime());
    return roles.map((item) => clone(item));
  }

  async update(id: string, fields: Partial<CreateRole>): Promise<Role> {
    const current = await this.require(id);
    const updated: Role = {
      ...current,
      ...fields,
      updated_at: nowIso(),
    };
    this.store.roles.set(id, clone(updated));
    return clone(updated);
  }

  async delete(id: string): Promise<boolean> {
    return this.store.roles.delete(id);
  }

  async getStats(id: string): Promise<{ group_count: number; groups: Array<{ id: string; name: string }> }> {
    await this.require(id);
    const groupMap = new Map<string, string>();
    for (const member of this.store.groupMembers.values()) {
      if (member.role_id !== id) {
        continue;
      }
      const group = this.store.groups.get(member.group_id);
      if (group) {
        groupMap.set(group.id, group.name);
      }
    }
    const groups = [...groupMap.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([groupId, name]) => ({ id: groupId, name }));
    return { group_count: groups.length, groups };
  }
}


