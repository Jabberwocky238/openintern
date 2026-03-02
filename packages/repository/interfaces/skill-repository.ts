import type { CreateSkill, Skill } from '@openintern/types/skill.js';

export interface ISkillRepository {
  create(input: CreateSkill): Promise<Skill>;
  getById(id: string): Promise<Skill | null>;
  require(id: string): Promise<Skill>;
  list(): Promise<Skill[]>;
  updateHealthStatus(id: string, status: Skill['health_status']): Promise<Skill>;
  delete(id: string): Promise<boolean>;
}


