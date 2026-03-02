import type { RuntimeTool, ToolContext } from '../_helpers.js';
import { extractString } from '../_helpers.js';
import { ToolError } from '@openintern/utils';
import { generateRunId } from '@openintern/utils';

export function register(ctx: ToolContext): RuntimeTool[] {
  return [
    {
      name: 'handoff_to',
      description:
        'Delegate a task to a specific agent role. Current run suspends until delegate completes.',
      parameters: {
        type: 'object',
        properties: {
          role_id: { type: 'string', description: 'Target role ID' },
          goal: { type: 'string', description: 'What the delegate should accomplish' },
          context: { type: 'string', description: 'Additional context (optional)' },
        },
        required: ['role_id', 'goal'],
      },
      source: 'builtin',
      metadata: { risk_level: 'medium', mutating: true, supports_parallel: false },
      handler: async (params) => {
        return handleRouting(ctx, [
          {
            role_id: extractString(params['role_id']),
            goal: extractString(params['goal']),
            context: extractString(params['context']),
            tool_call_id: extractString(params['__tool_call_id']),
          },
        ]);
      },
    },
    {
      name: 'dispatch_subtasks',
      description:
        'Fan out subtasks to multiple agent roles in parallel. Current run suspends until all complete. Use role_id values (not role display names).',
      parameters: {
        type: 'object',
        properties: {
          subtasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                role_id: { type: 'string', description: 'Target role ID' },
                goal: { type: 'string', description: 'Subtask goal' },
                context: { type: 'string', description: 'Subtask context (optional)' },
              },
              required: ['role_id', 'goal'],
            },
          },
        },
        required: ['subtasks'],
      },
      source: 'builtin',
      metadata: { risk_level: 'medium', mutating: true, supports_parallel: false },
      handler: async (params) => {
        const subtasks = params['subtasks'];
        if (!Array.isArray(subtasks) || subtasks.length === 0) {
          throw new ToolError('subtasks must be a non-empty array', 'dispatch_subtasks');
        }
        return handleRouting(
          ctx,
          subtasks.map((s: Record<string, unknown>) => ({
            role_id: extractString(s['role_id']),
            goal: extractString(s['goal']),
            context: extractString(s['context']),
            tool_call_id: extractString(params['__tool_call_id']),
          }))
        );
      },
    },
  ];
}

async function handleRouting(
  ctx: ToolContext,
  subtasks: Array<{ role_id: string | null; goal: string | null; context: string | null; tool_call_id?: string | null }>
): Promise<unknown> {
  const { runRepository, roleRepository, runQueue } = ctx;
  if (!runRepository || !roleRepository || !runQueue) {
    throw new ToolError('Routing dependencies not configured', 'handoff_to');
  }
  if (!ctx.currentRunId || !ctx.currentSessionKey) {
    throw new ToolError('Run context not set', 'handoff_to');
  }
  const currentRunId = ctx.currentRunId;
  const currentSessionKey = ctx.currentSessionKey;

  // Validate all inputs first
  for (const st of subtasks) {
    if (!st.role_id) throw new ToolError('role_id is required', 'handoff_to');
    if (!st.goal) throw new ToolError('goal is required', 'handoff_to');
    const role = await roleRepository.getById(st.role_id);
    if (!role) throw new ToolError(`Role not found: ${st.role_id}`, 'handoff_to');
  }

  // Create child runs + dependencies
  const childRunIds: string[] = [];
  for (const st of subtasks) {
    const roleId = st.role_id;
    const goal = st.goal;
    if (!roleId || !goal) {
      throw new ToolError('role_id and goal are required', 'handoff_to');
    }
    const childRunId = generateRunId();
    const childInput = st.context
      ? `Goal: ${goal}\n\nContext: ${st.context}`
      : `Goal: ${goal}`;

    await runRepository.createRun({
      id: childRunId,
      scope: ctx.scope,
      sessionKey: currentSessionKey,
      input: childInput,
      agentId: roleId,
      llmConfig: null,
      parentRunId: currentRunId,
    });

    await runRepository.createDependency(
      currentRunId,
      childRunId,
      st.tool_call_id ?? `routing_${childRunId}`,
      roleId,
      goal
    );

    await runQueue.enqueue(childRunId);
    childRunIds.push(childRunId);
  }

  return {
    success: false,
    requiresSuspension: true,
    childRunIds,
    message: `Dispatched ${childRunIds.length} subtask(s). Run will suspend until completion.`,
  };
}

