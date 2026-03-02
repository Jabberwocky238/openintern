import type { CreateSkill, Skill } from '../../../types/skill.js';
import { NotFoundError } from '../../../utils/errors.js';
import { generateSkillId } from '../../../utils/ids.js';
import type { ISkillRepository } from '../interfaces/skill-repository.js';
import { clone, nowIso } from './helpers.js';
import { resolveMemoryRepositoryStore, type MemoryRepositoryStore } from './store.js';

export class SkillRepository implements ISkillRepository {
  private readonly store: MemoryRepositoryStore;

  constructor(storeOrPool?: unknown) {
    this.store = resolveMemoryRepositoryStore(storeOrPool);
  }

  async create(input: CreateSkill): Promise<Skill> {
    const now = nowIso();
    const skill: Skill = {
      id: generateSkillId(),
      name: input.name,
      description: input.description ?? '',
      tools: input.tools ?? [],
      risk_level: input.risk_level ?? 'low',
      provider: input.provider ?? 'builtin',
      health_status: 'unknown',
      entry_path: input.entry_path,
      source_type: input.source_type,
      allow_implicit_invocation: input.allow_implicit_invocation ?? false,
      dependencies: input.dependencies,
      created_at: now,
      updated_at: now,
    };
    this.store.skills.set(skill.id, clone(skill));
    return clone(skill);
  }

  async getById(id: string): Promise<Skill | null> {
    const skill = this.store.skills.get(id);
    return skill ? clone(skill) : null;
  }

  async require(id: string): Promise<Skill> {
    const skill = await this.getById(id);
    if (!skill) {
      throw new NotFoundError('Skill', id);
    }
    return skill;
  }

  async list(): Promise<Skill[]> {
    return [...this.store.skills.values()]
      .sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime())
      .map((skill) => clone(skill));
  }

  async updateHealthStatus(id: string, status: Skill['health_status']): Promise<Skill> {
    const current = await this.require(id);
    const updated: Skill = {
      ...current,
      health_status: status,
      updated_at: nowIso(),
    };
    this.store.skills.set(id, clone(updated));
    return clone(updated);
  }

  async delete(id: string): Promise<boolean> {
    return this.store.skills.delete(id);
  }
}

