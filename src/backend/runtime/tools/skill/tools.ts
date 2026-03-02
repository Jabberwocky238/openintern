import type { RuntimeTool, ToolContext } from '../_helpers.js';
import { extractString } from '../_helpers.js';
import { ToolError } from '../../../../utils/errors.js';

export function register(ctx: ToolContext): RuntimeTool[] {
  return [
    {
      name: 'skills_list',
      description: 'List available skills and their tools',
      parameters: {
        type: 'object',
        properties: {
          include_tools: { type: 'boolean', default: true },
          provider: { type: 'string', enum: ['builtin', 'mcp'] },
          risk_level: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
      },
      source: 'builtin',
      metadata: { risk_level: 'low', mutating: false, supports_parallel: true },
      handler: (params) => {
        const includeTools = params['include_tools'] !== false;
        const provider = extractString(params['provider']);
        const riskLevel = extractString(params['risk_level']);
        let skills = ctx.skillRegistry?.listSkills() ?? [];
        if (provider) skills = skills.filter((s) => s.provider === provider);
        if (riskLevel) skills = skills.filter((s) => s.risk_level === riskLevel);
        return Promise.resolve({
          count: skills.length,
          skills: skills.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            risk_level: s.risk_level,
            provider: s.provider,
            health_status: s.health_status,
            ...(includeTools ? { tools: s.tools.map((t) => t.name) } : {}),
          })),
        });
      },
    },
    {
      name: 'skills_get',
      description: 'Get full details for one skill by id',
      parameters: {
        type: 'object',
        properties: { skill_id: { type: 'string' } },
        required: ['skill_id'],
      },
      source: 'builtin',
      metadata: { risk_level: 'low', mutating: false, supports_parallel: true },
      handler: (params) => {
        const skillId = extractString(params['skill_id']);
        if (!skillId) throw new ToolError('skill_id is required', 'skills_get');
        const skill = ctx.skillRegistry?.getSkill(skillId);
        if (!skill) throw new ToolError(`Skill not found: ${skillId}`, 'skills_get');
        return Promise.resolve({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          provider: skill.provider,
          risk_level: skill.risk_level,
          health_status: skill.health_status,
          tools: skill.tools,
        });
      },
    },
  ];
}

