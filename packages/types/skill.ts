import { z } from 'zod';

// ─── Risk Level ─────────────────────────────────────────────

export const RiskLevelSchema = z.enum(['low', 'medium', 'high']);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

// ─── Skill Provider ─────────────────────────────────────────

export const SkillProviderSchema = z.enum(['builtin', 'mcp']);
export type SkillProvider = z.infer<typeof SkillProviderSchema>;

// ─── Skill Tool Entry ───────────────────────────────────────

export const SkillToolEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  parameters: z.record(z.unknown()).default({}),
});

export type SkillToolEntry = z.infer<typeof SkillToolEntrySchema>;

// ─── Skill Source Type ──────────────────────────────────────

export const SkillSourceTypeSchema = z.enum(['local', 'repo', 'system', 'remote']);
export type SkillSourceType = z.infer<typeof SkillSourceTypeSchema>;

// ─── Skill Dependency ──────────────────────────────────────

export const SkillDependencySchema = z.object({
  tools: z.array(z.string()).default([]),
  env_vars: z.array(z.string()).default([]),
});

export type SkillDependency = z.infer<typeof SkillDependencySchema>;

// ─── Skill ──────────────────────────────────────────────────

export const SkillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  tools: z.array(SkillToolEntrySchema).default([]),
  risk_level: RiskLevelSchema.default('low'),
  provider: SkillProviderSchema.default('builtin'),
  health_status: z.enum(['healthy', 'unhealthy', 'unknown']).default('unknown'),
  /** Path to the SKILL.md or entry file */
  entry_path: z.string().optional(),
  /** Where this skill was discovered from */
  source_type: SkillSourceTypeSchema.optional(),
  /** Whether the model can auto-invoke this skill without explicit mention */
  allow_implicit_invocation: z.boolean().default(false),
  /** Tool and env dependencies */
  dependencies: SkillDependencySchema.optional(),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
});

export type Skill = z.infer<typeof SkillSchema>;

// ─── Create Skill ───────────────────────────────────────────

export const CreateSkillSchema = SkillSchema.omit({
  id: true,
  health_status: true,
  created_at: true,
  updated_at: true,
});

export type CreateSkill = z.infer<typeof CreateSkillSchema>;
