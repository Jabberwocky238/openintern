import { describe, expect, it, beforeEach } from 'vitest';
import { SkillRegistry } from './registry.js';
import type { Skill } from '../../../types/skill.js';

describe('SkillRegistry', () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    registry = new SkillRegistry();
  });

  function makeSkill(overrides: Partial<Skill> = {}): Skill {
    return {
      id: 'skill_1',
      name: 'Test Skill',
      description: '',
      tools: [
        { name: 'tool_a', description: 'Tool A', parameters: {} },
        { name: 'tool_b', description: 'Tool B', parameters: {} },
      ],
      risk_level: 'low',
      provider: 'builtin',
      health_status: 'healthy',
      allow_implicit_invocation: false,
      ...overrides,
    };
  }

  describe('register / unregister', () => {
    it('registers a skill and indexes its tools', () => {
      registry.register(makeSkill());

      expect(registry.listSkills()).toHaveLength(1);
      expect(registry.getSkill('skill_1')).toBeDefined();
      expect(registry.getToolMeta('tool_a')).not.toBeNull();
      expect(registry.getToolMeta('tool_b')).not.toBeNull();
    });

    it('unregisters a skill and removes tool index', () => {
      registry.register(makeSkill());
      registry.unregister('skill_1');

      expect(registry.listSkills()).toHaveLength(0);
      expect(registry.getToolMeta('tool_a')).toBeNull();
    });
  });

  describe('getToolMeta', () => {
    it('returns tool metadata with risk level from skill', () => {
      registry.register(makeSkill({ risk_level: 'high' }));

      const meta = registry.getToolMeta('tool_a');
      expect(meta).toEqual({
        name: 'tool_a',
        skillId: 'skill_1',
        riskLevel: 'high',
        source: 'builtin',
      });
    });

    it('returns null for unknown tool', () => {
      expect(registry.getToolMeta('unknown')).toBeNull();
    });
  });

  describe('getToolRiskLevel', () => {
    it('returns risk level for registered tool', () => {
      registry.register(makeSkill({ risk_level: 'medium' }));
      expect(registry.getToolRiskLevel('tool_a')).toBe('medium');
    });

    it('defaults to low for unknown tool', () => {
      expect(registry.getToolRiskLevel('unknown')).toBe('low');
    });
  });

  describe('getSkillForTool', () => {
    it('returns the skill owning a tool', () => {
      const skill = makeSkill();
      registry.register(skill);

      const found = registry.getSkillForTool('tool_a');
      expect(found?.id).toBe('skill_1');
    });

    it('returns undefined for unknown tool', () => {
      expect(registry.getSkillForTool('unknown')).toBeUndefined();
    });
  });

  describe('registerBuiltinTools', () => {
    it('splits tools by risk level into separate skills', () => {
      registry.registerBuiltinTools(
        ['read_file', 'memory_write', 'exec_cmd'],
        {
          read_file: 'low',
          memory_write: 'medium',
          exec_cmd: 'high',
        }
      );

      expect(registry.getToolRiskLevel('read_file')).toBe('low');
      expect(registry.getToolRiskLevel('memory_write')).toBe('medium');
      expect(registry.getToolRiskLevel('exec_cmd')).toBe('high');
    });

    it('defaults unspecified tools to low risk', () => {
      registry.registerBuiltinTools(['tool_x']);
      expect(registry.getToolRiskLevel('tool_x')).toBe('low');
    });

    it('clear removes all indexed skills and tools', () => {
      registry.registerBuiltinTools(['tool_x']);
      expect(registry.getToolMeta('tool_x')).not.toBeNull();
      registry.clear();
      expect(registry.listSkills()).toHaveLength(0);
      expect(registry.getToolMeta('tool_x')).toBeNull();
    });
  });
});

