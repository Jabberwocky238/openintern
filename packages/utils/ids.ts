import { randomBytes } from 'crypto';

/**
 * Generate a random alphanumeric string
 */
function randomAlphanumeric(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    const byte = bytes[i];
    if (byte !== undefined) {
      result += chars[byte % chars.length];
    }
  }
  return result;
}

/**
 * Generate a run ID (format: run_<alphanumeric>)
 */
export function generateRunId(): string {
  return `run_${randomAlphanumeric(12)}`;
}

/**
 * Generate a span ID (format: sp_<alphanumeric>)
 */
export function generateSpanId(): string {
  return `sp_${randomAlphanumeric(12)}`;
}

/**
 * Generate a memory ID (format: mem_<alphanumeric>)
 */
export function generateMemoryId(): string {
  return `mem_${randomAlphanumeric(12)}`;
}

/**
 * Generate a step ID (format: step_<number>)
 */
export function generateStepId(stepNumber: number): string {
  return `step_${stepNumber.toString().padStart(4, '0')}`;
}

/**
 * Generate a role ID (format: role_<alphanumeric>)
 */
export function generateRoleId(): string {
  return `role_${randomAlphanumeric(12)}`;
}

/**
 * Generate a group ID (format: grp_<alphanumeric>)
 */
export function generateGroupId(): string {
  return `grp_${randomAlphanumeric(12)}`;
}

/**
 * Generate a group member ID (format: gm_<alphanumeric>)
 */
export function generateGroupMemberId(): string {
  return `gm_${randomAlphanumeric(12)}`;
}

/**
 * Generate an agent instance ID (format: ai_<alphanumeric>)
 */
export function generateAgentInstanceId(): string {
  return `ai_${randomAlphanumeric(12)}`;
}

/**
 * Generate a skill ID (format: skill_<alphanumeric>)
 */
export function generateSkillId(): string {
  return `skill_${randomAlphanumeric(12)}`;
}

/**
 * Generate a plugin ID (format: plug_<alphanumeric>)
 */
export function generatePluginId(): string {
  return `plug_${randomAlphanumeric(12)}`;
}

/**
 * Generate a plugin job ID (format: pjob_<alphanumeric>)
 */
export function generatePluginJobId(): string {
  return `pjob_${randomAlphanumeric(12)}`;
}

/** @deprecated Use generatePluginId */
export function generateFeishuConnectorId(): string {
  return generatePluginId();
}

/** @deprecated Use generatePluginJobId */
export function generateFeishuSyncJobId(): string {
  return generatePluginJobId();
}

/**
 * Generate an upload ID (format: upl_<alphanumeric>)
 */
export function generateUploadId(): string {
  return `upl_${randomAlphanumeric(16)}`;
}
