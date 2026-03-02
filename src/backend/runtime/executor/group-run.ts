import type { QueuedRun } from '@openintern/types/api.js';
import type { LLMConfig } from '@openintern/types/agent.js';
import type { RuntimeExecutorConfig } from '../executor.js';
import type { RuntimeToolRouter } from '../tool-router.js';
import type { ToolCallScheduler } from '../tool-scheduler.js';
import type { SkillLoader } from '../skill/loader.js';
import { SingleAgentRunner } from '../agent-runner.js';
import { PromptComposer } from '../prompt-composer.js';
import { consumeEventStream } from './event-consumer.js';

type Scope = { orgId: string; userId: string; projectId: string | null };
type RunTerminalStatus = 'completed' | 'failed' | 'cancelled' | 'suspended';

export async function executeGroupRun(
  config: RuntimeExecutorConfig,
  run: QueuedRun,
  scope: Scope,
  modelConfig: LLMConfig,
  toolRouter: RuntimeToolRouter,
  signal: AbortSignal,
  extras?: {
    toolScheduler?: ToolCallScheduler;
    skillLoader?: SkillLoader;
  }
): Promise<RunTerminalStatus> {
  const groupId = run.group_id!;
  const members = await config.groupRepository.listMembers(groupId);
  if (members.length === 0) {
    throw new Error(`Group ${groupId} has no members`);
  }

  const group = await config.groupRepository.getGroup(groupId);
  if (!group) throw new Error(`Group ${groupId} not found`);

  // Build member roster for dispatcher system prompt
  const roster: string[] = [];
  for (const member of members) {
    const role = await config.roleRepository.getById(member.role_id);
    if (!role) throw new Error(`Role ${member.role_id} not found for member ${member.id}`);
    roster.push(`- ${role.name} (role_id: "${role.id}"): ${role.description}`);
  }

  const dispatcherPrompt = `You are the dispatcher for group "${group.name}": ${group.description}

Available team members:
${roster.join('\n')}

Instructions:
- Analyze the request and delegate to the right specialist(s)
- Use handoff_to(role_id, goal) for single tasks
- Use dispatch_subtasks([...]) for parallel work
- When results return, synthesize a final answer
- Do NOT do the work yourself �?delegate.`;

  const promptComposer = new PromptComposer({
    ...(modelConfig.provider !== 'mock' && { provider: modelConfig.provider }),
  });

  const runner = new SingleAgentRunner({
    maxSteps: config.maxSteps,
    modelConfig,
    checkpointService: config.checkpointService,
    memoryService: config.memoryService,
    toolRouter,
    promptComposer,
    ...(extras?.toolScheduler ? { toolScheduler: extras.toolScheduler } : {}),
    workDir: config.workDir,
    ...(config.budget ? { budget: config.budget } : {}),
    systemPrompt: dispatcherPrompt,
  });

  // Check for existing checkpoint (resume from suspension)
  const checkpoint = await config.checkpointService.loadLatest(run.run_id, run.agent_id);
  const resumeFrom = checkpoint ? {
    stepNumber: checkpoint.stepNumber,
    messages: checkpoint.messages,
    workingState: checkpoint.workingState,
  } : undefined;

  const status = await consumeEventStream(
    config,
    run.run_id,
    runner.run(run.input, {
      runId: run.run_id,
      sessionKey: run.session_key,
      scope,
      agentId: run.agent_id,
      abortSignal: signal,
      onSuspend: async (reason: string) => {
        await config.runRepository.setRunSuspended(run.run_id, reason);
      },
      ...(resumeFrom ? { resumeFrom } : {}),
    }),
    signal,
    groupId,
    scope
  );
  return status ?? (signal.aborted ? 'cancelled' : 'completed');
}

