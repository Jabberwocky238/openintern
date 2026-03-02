import { z } from 'zod';

// ─── Role ────────────────────────────────────────────────────

export const RoleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  system_prompt: z.string().min(1),
  allowed_tools: z.array(z.string()).default([]),
  denied_tools: z.array(z.string()).default([]),
  style_constraints: z.record(z.unknown()).default({}),
  is_lead: z.boolean().default(false),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
});

export type Role = z.infer<typeof RoleSchema>;

export const CreateRoleSchema = RoleSchema.omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type CreateRole = z.infer<typeof CreateRoleSchema>;

// ─── Project ─────────────────────────────────────────────────

export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  org_id: z.string().min(1),
  created_at: z.string().datetime().optional(),
});

export type Project = z.infer<typeof ProjectSchema>;

// ─── Group ───────────────────────────────────────────────────

export const GroupSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  project_id: z.string().nullable().default(null),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
});

export type Group = z.infer<typeof GroupSchema>;

export const CreateGroupSchema = GroupSchema.omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type CreateGroup = z.infer<typeof CreateGroupSchema>;

// ─── Group Member ────────────────────────────────────────────

export const GroupMemberSchema = z.object({
  id: z.string().min(1),
  group_id: z.string().min(1),
  role_id: z.string().min(1),
  agent_instance_id: z.string().nullable().default(null),
  ordinal: z.number().int().nonnegative().default(0),
  created_at: z.string().datetime().optional(),
});

export type GroupMember = z.infer<typeof GroupMemberSchema>;

export const AddMemberSchema = z.object({
  role_id: z.string().min(1),
  ordinal: z.number().int().nonnegative().default(0),
});

export type AddMember = z.infer<typeof AddMemberSchema>;

// ─── Agent Instance ──────────────────────────────────────────

export const AgentInstanceSchema = z.object({
  id: z.string().min(1),
  role_id: z.string().min(1),
  project_id: z.string().nullable().default(null),
  preferences: z.record(z.unknown()).default({}),
  state: z.record(z.unknown()).default({}),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
});

export type AgentInstance = z.infer<typeof AgentInstanceSchema>;
