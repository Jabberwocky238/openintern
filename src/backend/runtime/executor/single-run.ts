import type { QueuedRun } from '../../../types/api.js';
import type { LLMConfig, Message, ContentPart } from '../../../types/agent.js';
import type { RuntimeExecutorConfig } from '../executor.js';
import type { RuntimeToolRouter } from '../tool-router.js';
import type { ToolCallScheduler } from '../tool-scheduler.js';
import type { SkillLoader } from '../skill/loader.js';
import type { AgentContext } from '../tool-policy.js';
import { SingleAgentRunner } from '../agent-runner.js';
import { CompactionService } from '../compaction-service.js';
import { PromptComposer } from '../prompt-composer.js';
import { TokenBudgetManager } from '../token-budget-manager.js';
import { UploadService } from '../upload-service.js';
import { logger } from '../../../utils/logger.js';
import { consumeEventStream } from './event-consumer.js';

type Scope = { orgId: string; userId: string; projectId: string | null };
type RunTerminalStatus = 'completed' | 'failed' | 'cancelled' | 'suspended';

export async function executeSingleRun(
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
  const skillInjections = await loadSkillInjections(config, extras?.skillLoader);
  const budgetManager = createBudgetManager(config);
  const compactionService = budgetManager ? new CompactionService() : undefined;
  const availableGroups = await queryAvailableGroups(config, run, scope);
  const agentContext = await resolveAgentContext(config, run);

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
    ...(budgetManager ? { budgetManager } : {}),
    ...(compactionService ? { compactionService } : {}),
    ...(skillInjections.length > 0 ? { skillInjections } : {}),
    ...(availableGroups && availableGroups.length > 0 ? { availableGroups } : {}),
    workDir: config.workDir,
    ...(agentContext ? { agentContext } : {}),
  });

  const history = await buildSessionHistory(config, run, scope);
  const inputContent = await resolveInputContent(config, run, scope);

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
      ...(history.length > 0 ? { history } : {}),
      ...(typeof inputContent !== 'string' ? { inputContent } : {}),
      onEvent: (event) => {
        config.sseManager.broadcastToRun(run.run_id, event);
        void config.eventService.write(event).catch((err) => {
          logger.warn('Failed to persist onEvent event', {
            runId: run.run_id, eventType: event.type,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      },
      onWaiting: async () => {
        await config.runRepository.setRunWaiting(run.run_id);
        config.runQueue?.notifyRunWaiting(run.run_id);
      },
      onResumed: async () => {
        await config.runRepository.setRunResumed(run.run_id);
        config.runQueue?.notifyRunResumed(run.run_id);
      },
      onSuspend: async (reason: string) => {
        await config.runRepository.setRunSuspended(run.run_id, reason);
      },
      ...(resumeFrom ? { resumeFrom } : {}),
    }),
    signal
  );
  return status ?? (signal.aborted ? 'cancelled' : 'completed');
}

// ─── Helpers ─────────────────────────────────────────────

async function loadSkillInjections(
  config: RuntimeExecutorConfig,
  skillLoader?: SkillLoader
): Promise<{ skillId: string; name: string; content: string }[]> {
  if (!skillLoader || !config.enableImplicitSkills) return [];
  const result: { skillId: string; name: string; content: string }[] = [];
  for (const skill of skillLoader.listImplicitSkills()) {
    const content = await skillLoader.loadSkillContent(skill.id);
    if (content) result.push({ skillId: skill.id, name: skill.name, content });
  }
  return result;
}

function createBudgetManager(config: RuntimeExecutorConfig): TokenBudgetManager | undefined {
  if (!config.budget) return undefined;
  return new TokenBudgetManager({
    ...(config.budget.maxContextTokens !== undefined ? { maxContextTokens: config.budget.maxContextTokens } : {}),
    ...(config.budget.compactionThreshold !== undefined ? { compactionThreshold: config.budget.compactionThreshold } : {}),
    ...(config.budget.warningThreshold !== undefined ? { warningThreshold: config.budget.warningThreshold } : {}),
    ...(config.budget.reserveTokens !== undefined ? { reserveTokens: config.budget.reserveTokens } : {}),
  });
}

async function queryAvailableGroups(
  config: RuntimeExecutorConfig,
  run: QueuedRun,
  scope: Scope
) {
  try {
    return await config.groupRepository.listGroupsWithRoles(scope.projectId ?? undefined);
  } catch (error) {
    logger.warn('Failed to query available groups for prompt injection', {
      runId: run.run_id,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

async function resolveAgentContext(
  config: RuntimeExecutorConfig,
  run: QueuedRun
): Promise<AgentContext | undefined> {
  try {
    let role = await config.roleRepository.getRoleByAgentId(run.agent_id);
    if (!role) {
      logger.info('Using default role for agent (no restrictions except risk-level)', {
        runId: run.run_id, agentId: run.agent_id,
      });
      role = {
        id: 'default',
        name: 'Default Role',
        description: 'Default role with no tool restrictions',
        system_prompt: '',
        allowed_tools: [],
        denied_tools: [],
        style_constraints: {},
        is_lead: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    }

    const { ToolPolicy } = await import('../tool-policy.js');
    const runRecord = await config.runRepository.getRunById(run.run_id);
    const ctx = ToolPolicy.contextFromRole(
      role, run.agent_id, runRecord?.delegatedPermissions ?? undefined
    );
    logger.info('Agent context created for policy checks', {
      runId: run.run_id, agentId: run.agent_id, roleId: role.id,
      allowedToolsCount: role.allowed_tools.length,
      deniedToolsCount: role.denied_tools.length,
    });
    return ctx;
  } catch (error) {
    logger.error('Failed to create agent context', {
      runId: run.run_id, agentId: run.agent_id,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

async function buildSessionHistory(
  config: RuntimeExecutorConfig,
  run: QueuedRun,
  scope: Scope
): Promise<Message[]> {
  const history: Message[] = [];
  try {
    const priorRuns = await config.runRepository.listSessionHistory(scope, run.session_key, 20);
    for (const priorRun of priorRuns) {
      if (priorRun.id === run.run_id) continue;
      history.push({ role: 'user', content: priorRun.input });
      if (priorRun.result) {
        history.push({ role: 'assistant', content: priorRun.result });
      }
    }
  } catch (error) {
    logger.warn('Failed to reconstruct session history', {
      runId: run.run_id, sessionKey: run.session_key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return history;
}

async function resolveInputContent(
  config: RuntimeExecutorConfig,
  run: QueuedRun,
  scope: Scope
): Promise<string | ContentPart[]> {
  if (!run.attachments || run.attachments.length === 0) return run.input;
  try {
    const uploadService = new UploadService(config.workDir.replace(/\/workspace$/, ''));
    const parts = await uploadService.resolveAttachments(
      run.attachments.map((a) => a.upload_id), scope,
    );
    if (parts.length > 0) {
      return [{ type: 'text' as const, text: run.input }, ...parts];
    }
  } catch (error) {
    logger.warn('Failed to resolve attachments, proceeding with text only', {
      runId: run.run_id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return run.input;
}

