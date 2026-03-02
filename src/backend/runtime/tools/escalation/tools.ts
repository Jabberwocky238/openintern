import type { RuntimeTool, ToolContext } from '../_helpers.js';
import { extractString } from '../_helpers.js';
import { ToolError } from '@openintern/utils';
import { generateRunId } from '@openintern/utils';

export function register(ctx: ToolContext): RuntimeTool[] {
  return [
    {
      name: 'escalate_to_group',
      description:
        'Escalate a complex task to a specialized group of agents. Use this when the task requires expertise or capabilities beyond your own.',
      parameters: {
        type: 'object',
        properties: {
          group_id: { type: 'string', description: 'Optional. The ID of the group to escalate to.' },
          goal: { type: 'string', description: 'Clear description of what the group should accomplish' },
          context: { type: 'string', description: 'Relevant context from the current conversation' },
        },
        required: ['goal'],
      },
      source: 'builtin',
      metadata: { risk_level: 'medium', mutating: true, supports_parallel: false },
      handler: async (params) => {
        const { escalationService, runRepository, groupRepository, runQueue } = ctx;
        if (!escalationService || !runRepository || !groupRepository || !runQueue) {
          throw new ToolError('Escalation dependencies not configured', 'escalate_to_group');
        }
        if (!ctx.currentRunId || !ctx.currentSessionKey) {
          throw new ToolError('Run context is not set; cannot escalate outside of a run', 'escalate_to_group');
        }

        const goal = extractString(params['goal']);
        const context = extractString(params['context']);
        if (!goal) throw new ToolError('goal is required', 'escalate_to_group');

        // Resolve group
        const groupId = extractString(params['group_id'])
          ?? await escalationService.selectGroup(goal, ctx.scope.projectId ?? undefined);

        const group = await groupRepository.getGroup(groupId);
        if (!group) throw new ToolError(`Group not found: ${groupId}`, 'escalate_to_group');

        const members = await groupRepository.listMembers(groupId);
        if (members.length === 0) {
          throw new ToolError(`Group ${groupId} has no members`, 'escalate_to_group');
        }

        // Build child run
        const childRunId = generateRunId();
        const childInput = context ? `Goal: ${goal}\n\nContext: ${context}` : `Goal: ${goal}`;

        const parentRun = await runRepository.getRunById(ctx.currentRunId);
        const delegatedPermissions = ctx.currentAgentContext?.delegatedPermissions
          ?? parentRun?.delegatedPermissions ?? null;

        await runRepository.createRun({
          id: childRunId,
          scope: ctx.scope,
          sessionKey: ctx.currentSessionKey!,
          input: childInput,
          agentId: 'orchestrator',
          runMode: 'group',
          groupId,
          llmConfig: null,
          parentRunId: ctx.currentRunId!,
          ...(delegatedPermissions ? { delegatedPermissions } : {}),
        });

        await runRepository.createDependency(
          ctx.currentRunId!, childRunId, `escalation_${childRunId}`, null, goal
        );

        await runQueue.enqueue(childRunId);

        return {
          success: false,
          requiresSuspension: true,
          childRunIds: [childRunId],
          message: `Escalated to group "${group.name}". Run will suspend until group completes.`,
        };
      },
    },
    {
      name: 'list_available_groups',
      description: 'List all available groups that can be escalated to, along with their capabilities.',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Optional. Filter groups by project.' },
        },
      },
      source: 'builtin',
      metadata: { risk_level: 'low', mutating: false, supports_parallel: true },
      handler: async (params) => {
        const groupRepository = ctx.groupRepository;
        if (!groupRepository) {
          throw new ToolError('Group repository is not configured', 'list_available_groups');
        }
        const projectId = extractString(params['project_id']) ?? ctx.scope.projectId ?? undefined;
        const groups = await groupRepository.listGroupsWithRoles(projectId);
        return {
          groups: groups.map((g) => ({
            id: g.id,
            name: g.name,
            description: g.description,
            members: g.members.map((m) => ({
              role_id: m.role_id,
              role: m.role_name,
              description: m.role_description,
            })),
          })),
        };
      },
    },
  ];
}

