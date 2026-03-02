import type { Skill } from '../../../types/skill.js';
import type { RiskLevel } from '../../../types/skill.js';
import type { ToolMeta } from '../tool-policy.js';
import { logger } from '../../../utils/logger.js';

/**
 * SkillRegistry provides a unified view of all registered skills
 * (builtin + MCP) and maps tool names to their risk levels.
 */
export class SkillRegistry {
  private readonly skills = new Map<string, Skill>();
  private readonly toolToSkill = new Map<string, string>();

  /**
   * Remove all registered skills and tool indexes.
   */
  clear(): void {
    this.skills.clear();
    this.toolToSkill.clear();
  }

  /**
   * Register a skill and index its tools.
   */
  register(skill: Skill): void {
    this.skills.set(skill.id, skill);
    for (const tool of skill.tools) {
      this.toolToSkill.set(tool.name, skill.id);
    }
    logger.info('Skill registered', {
      skillId: skill.id,
      name: skill.name,
      toolCount: skill.tools.length,
    });
  }

  /**
   * Unregister a skill and remove its tool index entries.
   */
  unregister(skillId: string): void {
    const skill = this.skills.get(skillId);
    if (!skill) return;
    for (const tool of skill.tools) {
      if (this.toolToSkill.get(tool.name) === skillId) {
        this.toolToSkill.delete(tool.name);
      }
    }
    this.skills.delete(skillId);
  }

  /**
   * Get tool metadata for policy checks.
   * Returns null if the tool is not registered in any skill.
   */
  getToolMeta(toolName: string): ToolMeta | null {
    const skillId = this.toolToSkill.get(toolName);
    if (!skillId) return null;
    const skill = this.skills.get(skillId);
    if (!skill) return null;
    return {
      name: toolName,
      skillId,
      riskLevel: skill.risk_level,
      source: skill.provider,
    };
  }

  /**
   * Get risk level for a tool. Defaults to 'low' if unknown.
   */
  getToolRiskLevel(toolName: string): RiskLevel {
    return this.getToolMeta(toolName)?.riskLevel ?? 'low';
  }

  /**
   * List all registered skills.
   */
  listSkills(): Skill[] {
    return [...this.skills.values()];
  }

  /**
   * Get a skill by ID.
   */
  getSkill(skillId: string): Skill | undefined {
    return this.skills.get(skillId);
  }

  /**
   * Get the skill that owns a given tool.
   */
  getSkillForTool(toolName: string): Skill | undefined {
    const skillId = this.toolToSkill.get(toolName);
    return skillId ? this.skills.get(skillId) : undefined;
  }

  /**
   * Register builtin tools as a single skill entry.
   */
  registerBuiltinTools(
    toolNames: string[],
    riskLevels?: Record<string, RiskLevel>
  ): void {
    const tools = toolNames.map((name) => ({
      name,
      description: '',
      parameters: {},
    }));

    // Split by risk level
    const lowTools = tools.filter(
      (t) => (riskLevels?.[t.name] ?? 'low') === 'low'
    );
    const medTools = tools.filter(
      (t) => riskLevels?.[t.name] === 'medium'
    );
    const highTools = tools.filter(
      (t) => riskLevels?.[t.name] === 'high'
    );

    if (lowTools.length > 0) {
      this.register({
        id: 'builtin_low',
        name: 'Builtin (low risk)',
        description: 'Built-in read-only tools',
        tools: lowTools,
        risk_level: 'low',
        provider: 'builtin',
        health_status: 'healthy',
        allow_implicit_invocation: false,
      });
    }
    if (medTools.length > 0) {
      this.register({
        id: 'builtin_medium',
        name: 'Builtin (medium risk)',
        description: 'Built-in write tools',
        tools: medTools,
        risk_level: 'medium',
        provider: 'builtin',
        health_status: 'healthy',
        allow_implicit_invocation: false,
      });
    }
    if (highTools.length > 0) {
      this.register({
        id: 'builtin_high',
        name: 'Builtin (high risk)',
        description: 'Built-in high-risk tools',
        tools: highTools,
        risk_level: 'high',
        provider: 'builtin',
        health_status: 'healthy',
        allow_implicit_invocation: false,
      });
    }
  }
}

