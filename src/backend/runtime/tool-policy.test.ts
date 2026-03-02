import { describe, expect, it } from 'vitest';
import { ToolPolicy } from './tool-policy.js';
import type { AgentContext, ToolMeta } from './tool-policy.js';

describe('ToolPolicy', () => {
  const policy = new ToolPolicy();

  function makeAgent(overrides: Partial<AgentContext> = {}): AgentContext {
    return {
      agentId: 'agent_1',
      roleId: 'role_1',
      allowedTools: [],
      deniedTools: [],
      ...overrides,
    };
  }

  function makeTool(overrides: Partial<ToolMeta> = {}): ToolMeta {
    return {
      name: 'read_file',
      riskLevel: 'low',
      source: 'builtin',
      ...overrides,
    };
  }

  describe('default policy (no allowed/denied)', () => {
    it('allows low risk tools', () => {
      const result = policy.check(makeAgent(), makeTool({ riskLevel: 'low' }));
      expect(result.allowed).toBe(true);
    });

    it('allows medium risk tools', () => {
      const result = policy.check(makeAgent(), makeTool({ riskLevel: 'medium' }));
      expect(result.allowed).toBe(true);
    });

    it('blocks high risk tools', () => {
      const result = policy.check(makeAgent(), makeTool({ riskLevel: 'high' }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('high risk');
    });
  });

  describe('denied_tools (blacklist)', () => {
    it('blocks explicitly denied tool regardless of risk level', () => {
      const agent = makeAgent({ deniedTools: ['read_file'] });
      const tool = makeTool({ name: 'read_file', riskLevel: 'low' });
      const result = policy.check(agent, tool);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('explicitly denied');
    });

    it('allows tools not in denied list', () => {
      const agent = makeAgent({ deniedTools: ['memory_write'] });
      const tool = makeTool({ name: 'read_file', riskLevel: 'low' });
      const result = policy.check(agent, tool);
      expect(result.allowed).toBe(true);
    });

    it('blocks tool when its skill id is explicitly denied', () => {
      const agent = makeAgent({ deniedTools: ['skill_fs'] });
      const tool = makeTool({ name: 'read_file', skillId: 'skill_fs' });
      const result = policy.check(agent, tool);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('explicitly denied');
    });
  });

  describe('allowed_tools (whitelist)', () => {
    it('allows tool in whitelist', () => {
      const agent = makeAgent({ allowedTools: ['read_file', 'memory_search'] });
      const tool = makeTool({ name: 'read_file' });
      const result = policy.check(agent, tool);
      expect(result.allowed).toBe(true);
    });

    it('blocks tool not in whitelist', () => {
      const agent = makeAgent({ allowedTools: ['memory_search'] });
      const tool = makeTool({ name: 'read_file' });
      const result = policy.check(agent, tool);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not in the allowed list');
    });

    it('requires approval for high risk tool even if whitelisted', () => {
      const agent = makeAgent({ allowedTools: ['dangerous_tool'] });
      const tool = makeTool({ name: 'dangerous_tool', riskLevel: 'high' });
      const result = policy.check(agent, tool);
      expect(result.allowed).toBe(false);
      expect(result.decision).toBe('ask');
      expect(result.reason).toContain('high risk');
    });

    it('allows tool when its skill id is in whitelist', () => {
      const agent = makeAgent({ allowedTools: ['skill:skill_fs'] });
      const tool = makeTool({ name: 'read_file', skillId: 'skill_fs' });
      const result = policy.check(agent, tool);
      expect(result.allowed).toBe(true);
    });
  });

  describe('priority: denied > allowed > risk_level', () => {
    it('denied takes precedence over allowed', () => {
      const agent = makeAgent({
        allowedTools: ['read_file'],
        deniedTools: ['read_file'],
      });
      const tool = makeTool({ name: 'read_file' });
      const result = policy.check(agent, tool);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('explicitly denied');
    });
  });

  describe('contextFromRole', () => {
    it('builds AgentContext from Role', () => {
      const role = {
        id: 'role_critic',
        name: 'Critic',
        system_prompt: 'You are a critic',
        allowed_tools: ['memory_search'],
        denied_tools: ['memory_write'],
        style_constraints: {},
        is_lead: false,
        description: '',
      };
      const ctx = ToolPolicy.contextFromRole(role, 'agent_42');
      expect(ctx.agentId).toBe('agent_42');
      expect(ctx.roleId).toBe('role_critic');
      expect(ctx.allowedTools).toEqual(['memory_search']);
      expect(ctx.deniedTools).toEqual(['memory_write']);
    });
  });

  describe('always allowed discovery tools', () => {
    it('allows skills_list even when whitelist does not include it', () => {
      const agent = makeAgent({ allowedTools: ['memory_search'] });
      const tool = makeTool({ name: 'skills_list', riskLevel: 'low' });
      const result = policy.check(agent, tool);
      expect(result.allowed).toBe(true);
    });
  });

  describe('checkWithDelegated', () => {
    it('falls back to standard check when no delegated permissions', () => {
      const agent = makeAgent({ allowedTools: ['read_file'] });
      const tool = makeTool({ name: 'read_file' });
      const result = policy.checkWithDelegated(agent, tool);
      expect(result.allowed).toBe(true);
    });

    it('blocks tool denied by delegated permissions', () => {
      const agent = makeAgent({
        allowedTools: ['read_file', 'write_file'],
        delegatedPermissions: { denied_tools: ['write_file'] },
      });
      const tool = makeTool({ name: 'write_file' });
      const result = policy.checkWithDelegated(agent, tool);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('denied by delegated permissions');
    });

    it('blocks tool not in delegated allowed list', () => {
      const agent = makeAgent({
        delegatedPermissions: { allowed_tools: ['read_file'] },
      });
      const tool = makeTool({ name: 'write_file' });
      const result = policy.checkWithDelegated(agent, tool);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not in the delegated allowed list');
    });

    it('allows tool in both delegated and role allowed lists', () => {
      const agent = makeAgent({
        allowedTools: ['read_file', 'write_file'],
        delegatedPermissions: { allowed_tools: ['read_file', 'write_file'] },
      });
      const tool = makeTool({ name: 'read_file' });
      const result = policy.checkWithDelegated(agent, tool);
      expect(result.allowed).toBe(true);
    });

    it('delegated denied takes precedence over delegated allowed', () => {
      const agent = makeAgent({
        delegatedPermissions: {
          allowed_tools: ['read_file'],
          denied_tools: ['read_file'],
        },
      });
      const tool = makeTool({ name: 'read_file' });
      const result = policy.checkWithDelegated(agent, tool);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('denied by delegated permissions');
    });

    it('intersection: role allows but delegated does not', () => {
      const agent = makeAgent({
        allowedTools: ['read_file', 'write_file'],
        delegatedPermissions: { allowed_tools: ['read_file'] },
      });
      const tool = makeTool({ name: 'write_file' });
      const result = policy.checkWithDelegated(agent, tool);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not in the delegated allowed list');
    });

    it('intersection: delegated allows but role does not', () => {
      const agent = makeAgent({
        allowedTools: ['read_file'],
        delegatedPermissions: { allowed_tools: ['read_file', 'write_file'] },
      });
      const tool = makeTool({ name: 'write_file' });
      const result = policy.checkWithDelegated(agent, tool);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not in the allowed list');
    });

    it('always allows discovery tools even with delegated restrictions', () => {
      const agent = makeAgent({
        delegatedPermissions: { allowed_tools: ['read_file'] },
      });
      const tool = makeTool({ name: 'skills_list', riskLevel: 'low' });
      const result = policy.checkWithDelegated(agent, tool);
      expect(result.allowed).toBe(true);
    });

    it('supports glob patterns in delegated allowed_tools', () => {
      const agent = makeAgent({
        delegatedPermissions: { allowed_tools: ['mcp__github__*'] },
      });
      const tool = makeTool({ name: 'mcp__github__create_issue' });
      const result = policy.checkWithDelegated(agent, tool);
      expect(result.allowed).toBe(true);
    });

    it('supports glob patterns in delegated denied_tools', () => {
      const agent = makeAgent({
        delegatedPermissions: { denied_tools: ['mcp__github__*'] },
      });
      const tool = makeTool({ name: 'mcp__github__create_issue' });
      const result = policy.checkWithDelegated(agent, tool);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('denied by delegated permissions');
    });

    it('empty delegated allowed_tools means no restriction from delegation', () => {
      const agent = makeAgent({
        delegatedPermissions: { allowed_tools: [] },
      });
      const tool = makeTool({ name: 'read_file', riskLevel: 'low' });
      const result = policy.checkWithDelegated(agent, tool);
      expect(result.allowed).toBe(true);
    });
  });

  describe('contextFromRole with delegatedPermissions', () => {
    it('includes delegatedPermissions when provided', () => {
      const role = {
        id: 'role_critic',
        name: 'Critic',
        system_prompt: 'You are a critic',
        allowed_tools: ['memory_search'],
        denied_tools: [],
        style_constraints: {},
        is_lead: false,
        description: '',
      };
      const dp = { allowed_tools: ['memory_search'], denied_tools: ['exec_command'] };
      const ctx = ToolPolicy.contextFromRole(role, 'agent_42', dp);
      expect(ctx.delegatedPermissions).toEqual(dp);
    });

    it('omits delegatedPermissions when not provided', () => {
      const role = {
        id: 'role_critic',
        name: 'Critic',
        system_prompt: 'You are a critic',
        allowed_tools: [],
        denied_tools: [],
        style_constraints: {},
        is_lead: false,
        description: '',
      };
      const ctx = ToolPolicy.contextFromRole(role, 'agent_42');
      expect(ctx.delegatedPermissions).toBeUndefined();
    });
  });
});

