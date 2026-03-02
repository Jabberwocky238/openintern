import type { QueuedRun } from '../../types/api.js';
import type { Message, ToolCall, ToolResult } from '../../types/agent.js';
import type { Event } from '../../types/events.js';
import type { LLMConfig } from '../../types/agent.js';
import type { SSEManager } from '../api/sse.js';
import { logger } from '../../utils/logger.js';
import { generateSpanId } from '../../utils/ids.js';
import { McpConnectionManager, type McpServerConfig } from './mcp-connection-manager.js';
import { SwarmCoordinator } from './swarm-coordinator.js';
import type { MemoryService } from './memory-service.js';
import { RuntimeToolRouter } from './tool-router.js';
import { SkillLoader } from './skill/loader.js';
import { ToolCallScheduler, ToolApprovalManager } from './tool-scheduler.js';
import { EscalationService } from './escalation-service.js';
import type { CheckpointService } from './checkpoint-service.js';
import type { EventService } from './event-service.js';
import type { GroupRepository } from '../repository/postgres/group-repository.js';
import type { RoleRepository } from '../repository/postgres/role-repository.js';
import type { RunRepository } from '../repository/postgres/run-repository.js';
import type { PlanRepository } from '../repository/postgres/plan-repository.js';
import type { SkillRepository } from '../repository/postgres/skill-repository.js';
import type { FeishuSyncService } from './integrations/feishu/sync-service.js';
import type { MineruIngestService } from './integrations/mineru/ingest-service.js';
import { refreshSkillRegistry } from './executor/skill-refresh.js';
import { executeSingleRun } from './executor/single-run.js';
import { executeGroupRun } from './executor/group-run.js';
import { executePlanRun } from './executor/plan-run.js';
import { formatToolResultMessageContent } from './tool-result-content.js';
import { buildHumanOverrideNote, hasHumanModifiedArgs } from './hitl-note.js';

type Scope = { orgId: string; userId: string; projectId: string | null };
type RunTerminalStatus = 'completed' | 'failed' | 'cancelled' | 'suspended';

// ─── Config & Result ─────────────────────────────────────────

export interface RuntimeExecutorConfig {
  runRepository: RunRepository;
  eventService: EventService;
  checkpointService: CheckpointService;
  memoryService: MemoryService;
  skillRepository: SkillRepository;
  sseManager: SSEManager;
  groupRepository: GroupRepository;
  roleRepository: RoleRepository;
  planRepository?: PlanRepository;
  feishuSyncService?: FeishuSyncService;
  mineruIngestService?: MineruIngestService;
  maxSteps: number;
  defaultModelConfig: LLMConfig;
  plannerModelConfig?: LLMConfig;
  workDir: string;
  mcp?: {
    enabled: boolean;
    pythonPath?: string;
    serverModule?: string;
    cwd?: string;
    timeoutMs?: number;
  };
  mcpServers?: McpServerConfig[];
  skillPaths?: string[];
  enableImplicitSkills?: boolean;
  budget?: {
    maxContextTokens?: number;
    compactionThreshold?: number;
    warningThreshold?: number;
    reserveTokens?: number;
  };
  persistLlmTokens?: boolean;
  runQueue?: {
    enqueue(run: QueuedRun): void;
    notifyRunWaiting(runId: string): void;
    notifyRunResumed(runId: string): void;
  };
  swarmCoordinator?: import('./swarm-coordinator.js').SwarmCoordinator;
}

export interface RuntimeExecutorResult {
  execute: (run: QueuedRun, signal: AbortSignal) => Promise<{ status: RunTerminalStatus }>;
  approvalManager: ToolApprovalManager;
}

// ─── Helpers ─────────────────────────────────────────────────

function isCancellationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: string; message?: string };
  if (e.name === 'AbortError' || e.name === 'RunCancelledError') return true;
  const msg = (e.message ?? '').toLowerCase();
  return msg.includes('aborted') || msg.includes('cancelled');
}

function resolveModelConfig(run: QueuedRun, defaults: LLMConfig): LLMConfig {
  const provider = run.llm_config?.provider ?? defaults.provider;
  const model = run.llm_config?.model ?? defaults.model;
  const mc: LLMConfig = { provider, model };

  if (provider === defaults.provider && defaults.apiKey) mc.apiKey = defaults.apiKey;
  if (run.llm_config?.base_url) mc.baseUrl = run.llm_config.base_url;
  else if (provider === defaults.provider && defaults.baseUrl) mc.baseUrl = defaults.baseUrl;

  const temperature = run.llm_config?.temperature ?? defaults.temperature;
  if (temperature !== undefined) mc.temperature = temperature;
  const maxTokens = run.llm_config?.max_tokens ?? defaults.maxTokens;
  if (maxTokens !== undefined) mc.maxTokens = maxTokens;

  return mc;
}

function mapRunRecordToQueuedRun(run: Awaited<ReturnType<RunRepository['getRunById']>>): QueuedRun | null {
  if (!run) return null;
  return {
    run_id: run.id,
    org_id: run.orgId,
    user_id: run.userId,
    ...(run.projectId ? { project_id: run.projectId } : {}),
    session_key: run.sessionKey,
    input: run.input,
    agent_id: run.agentId,
    run_mode: run.runMode ?? (run.groupId ? 'group' : 'single'),
    created_at: run.createdAt,
    status: 'pending',
    ...(run.llmConfig ? { llm_config: run.llmConfig } : {}),
    ...(run.groupId ? { group_id: run.groupId } : {}),
    ...(run.parentRunId ? { parent_run_id: run.parentRunId } : {}),
  };
}

function findToolCallById(messages: Message[], toolCallId: string): ToolCall | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message?.toolCalls || message.role !== 'assistant') continue;
    const matched = message.toolCalls.find((call) => call.id === toolCallId);
    if (matched) return matched;
  }
  return null;
}

function createHumanIntervenedToolCalledEvent(args: {
  runId: string;
  sessionKey: string;
  agentId: string;
  stepId: string;
  toolName: string;
  toolCallId: string;
  effectiveArgs: Record<string, unknown>;
}): Event {
  return {
    v: 1,
    ts: new Date().toISOString(),
    session_key: args.sessionKey,
    run_id: args.runId,
    agent_id: args.agentId,
    step_id: args.stepId,
    span_id: generateSpanId(),
    parent_span_id: null,
    redaction: { contains_secrets: false },
    type: 'tool.called',
    payload: {
      toolName: args.toolName,
      args: args.effectiveArgs,
      tool_call_id: args.toolCallId,
      human_intervened: true,
      modified_args_applied: true,
      effective_args: args.effectiveArgs,
    },
  };
}

function createToolApprovedEvent(args: {
  runId: string;
  sessionKey: string;
  agentId: string;
  stepId: string;
  toolName: string;
  toolCallId: string;
  modifiedArgs?: Record<string, unknown>;
  modifiedArgsApplied: boolean;
}): Event {
  return {
    v: 1,
    ts: new Date().toISOString(),
    session_key: args.sessionKey,
    run_id: args.runId,
    agent_id: args.agentId,
    step_id: args.stepId,
    span_id: generateSpanId(),
    parent_span_id: null,
    redaction: { contains_secrets: false },
    type: 'tool.approved',
    payload: {
      toolName: args.toolName,
      tool_call_id: args.toolCallId,
      modified_args_applied: args.modifiedArgsApplied,
      ...(args.modifiedArgs ? { modified_args: args.modifiedArgs } : {}),
    },
  };
}

function withInternalToolCallId(
  toolName: string,
  toolCallId: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  if (toolName !== 'handoff_to' && toolName !== 'dispatch_subtasks') {
    return args;
  }
  if ('__tool_call_id' in args) {
    return args;
  }
  return { ...args, __tool_call_id: toolCallId };
}

// ─── Factory ─────────────────────────────────────────────────

export function createRuntimeExecutor(config: RuntimeExecutorConfig): RuntimeExecutorResult {
  let sharedToolRouter: RuntimeToolRouter | null = null;
  let sharedToolRouterInit: Promise<RuntimeToolRouter> | null = null;
  let sharedMcpManager: McpConnectionManager | null = null;
  let sharedSkillLoader: SkillLoader | null = null;
  const sharedApprovalManager = new ToolApprovalManager();
  const sharedToolScheduler = new ToolCallScheduler({ approvalManager: sharedApprovalManager });
  const sharedSwarmCoordinator = config.swarmCoordinator
    ?? (config.runQueue
      ? new SwarmCoordinator({
          runRepository: config.runRepository,
          checkpointService: config.checkpointService,
          enqueueRun: (runId: string) => {
            void (async () => {
              const run = await config.runRepository.getRunById(runId);
              const queuedRun = mapRunRecordToQueuedRun(run);
              if (!queuedRun) {
                logger.warn('Cannot enqueue resumed parent run: run not found', { runId });
                return;
              }
              config.runQueue!.enqueue(queuedRun);
            })().catch((error: unknown) => {
              logger.error('Failed to enqueue resumed parent run', {
                runId,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          },
        })
      : undefined);

  async function getSkillLoader(): Promise<SkillLoader> {
    if (sharedSkillLoader) return sharedSkillLoader;
    const loader = new SkillLoader();
    if (config.skillPaths && config.skillPaths.length > 0) {
      await loader.discover(config.skillPaths);
    }
    sharedSkillLoader = loader;
    return loader;
  }

  async function getMcpManager(): Promise<McpConnectionManager | null> {
    if (sharedMcpManager) return sharedMcpManager;
    if (!config.mcpServers || config.mcpServers.length === 0) return null;
    const manager = new McpConnectionManager();
    await manager.initialize(config.mcpServers);
    sharedMcpManager = manager;
    return manager;
  }

  async function getSharedToolRouter(scope: Scope): Promise<RuntimeToolRouter> {
    if (sharedToolRouter) {
      sharedToolRouter.setScope(scope);
      await refreshSkillRegistry(sharedToolRouter, config.skillRepository);
      return sharedToolRouter;
    }
    if (!sharedToolRouterInit) {
      sharedToolRouterInit = (async () => {
        const escalationService = new EscalationService({
          runRepository: config.runRepository,
          groupRepository: config.groupRepository,
        });
        const router = new RuntimeToolRouter({
          scope,
          memoryService: config.memoryService,
          eventService: config.eventService,
          ...(config.feishuSyncService ? { feishuSyncService: config.feishuSyncService } : {}),
          ...(config.mineruIngestService ? { mineruIngestService: config.mineruIngestService } : {}),
          workDir: config.workDir,
          ...(config.mcp ? { mcp: config.mcp } : {}),
          escalationService,
          groupRepository: config.groupRepository,
          runRepository: config.runRepository,
          roleRepository: config.roleRepository,
          ...(config.runQueue
            ? {
                runQueue: {
                  enqueue: async (runId: string) => {
                    const run = await config.runRepository.getRunById(runId);
                    const queuedRun = mapRunRecordToQueuedRun(run);
                    if (!queuedRun) {
                      logger.warn('Cannot enqueue child run: run not found', { runId });
                      return;
                    }
                    config.runQueue!.enqueue(queuedRun);
                  },
                },
              }
            : {}),
        });
        await router.start();
        sharedToolRouter = router;
        return router;
      })().catch((error) => {
        sharedToolRouterInit = null;
        throw error;
      });
    }
    const router = await sharedToolRouterInit;
    router.setScope(scope);
    await refreshSkillRegistry(router, config.skillRepository);
    return router;
  }

  sharedApprovalManager.setSuspendedApprovalExecutor(async (request) => {
    const toolRouter = await getSharedToolRouter(request.scope);
    toolRouter.setRunContext(request.runId, request.sessionKey);

    const checkpoint = await config.checkpointService.loadLatest(
      request.runId,
      request.agentId
    );
    if (!checkpoint) {
      throw new Error(`No checkpoint found for suspended run ${request.runId}`);
    }

    const toolCall = findToolCallById(checkpoint.messages, request.toolCallId);
    if (!toolCall) {
      throw new Error(`Tool call ${request.toolCallId} not found in checkpoint`);
    }

    const effectiveArgs = request.modifiedArgs ?? toolCall.parameters;
    const modifiedArgsApplied = hasHumanModifiedArgs(
      toolCall.parameters,
      request.modifiedArgs
    );
    const approvedEvent = createToolApprovedEvent({
      runId: request.runId,
      sessionKey: request.sessionKey,
      agentId: request.agentId,
      stepId: checkpoint.stepId,
      toolName: toolCall.name,
      toolCallId: request.toolCallId,
      ...(request.modifiedArgs ? { modifiedArgs: request.modifiedArgs } : {}),
      modifiedArgsApplied,
    });
    await config.eventService.write(approvedEvent);
    config.sseManager.broadcastToRun(request.runId, approvedEvent);

    const validation = toolRouter.validateToolArgs(toolCall.name, effectiveArgs);

    let replayResult: ToolResult;
    if (!validation.ok) {
      replayResult = {
        success: false,
        error: `Invalid tool arguments: ${validation.message}`,
        duration: 0,
      };
    } else {
      const params = withInternalToolCallId(
        toolCall.name,
        request.toolCallId,
        effectiveArgs
      );
      replayResult = await toolRouter.callTool(toolCall.name, params);
    }

    if (modifiedArgsApplied) {
      replayResult = {
        ...replayResult,
        humanInterventionNote: buildHumanOverrideNote(effectiveArgs),
      };
      const modifiedEvent = createHumanIntervenedToolCalledEvent({
        runId: request.runId,
        sessionKey: request.sessionKey,
        agentId: request.agentId,
        stepId: checkpoint.stepId,
        toolName: toolCall.name,
        toolCallId: request.toolCallId,
        effectiveArgs,
      });
      await config.eventService.write(modifiedEvent);
      config.sseManager.broadcastToRun(request.runId, modifiedEvent);
    }

    await config.checkpointService.appendToolResults(
      request.runId,
      request.agentId,
      [
        {
          role: 'tool',
          toolCallId: request.toolCallId,
          content: formatToolResultMessageContent(replayResult),
        },
      ]
    );

    return {
      toolName: toolCall.name,
      effectiveArgs,
      modifiedArgsApplied,
    };
  });

  const execute = async (run: QueuedRun, signal: AbortSignal): Promise<{ status: RunTerminalStatus }> => {
    const scope: Scope = {
      orgId: run.org_id,
      userId: run.user_id,
      projectId: run.project_id ?? null,
    };
    const modelConfig = resolveModelConfig(run, config.defaultModelConfig);

    if (signal.aborted) {
      await config.runRepository.setRunCancelled(run.run_id);
      return { status: 'cancelled' };
    }

    const toolRouter = await getSharedToolRouter(scope);
    const skillLoader = await getSkillLoader();
    const mcpManager = await getMcpManager();
    toolRouter.setRunContext(run.run_id, run.session_key);
    await config.runRepository.setRunRunning(run.run_id);

    try {
      const extras = { toolScheduler: sharedToolScheduler, skillLoader, mcpManager };
      const status = run.run_mode === 'plan_execute'
        ? await executePlanRun(
            { ...config, ...(sharedSwarmCoordinator ? { swarmCoordinator: sharedSwarmCoordinator } : {}) },
            run,
            scope,
            modelConfig,
            signal
          )
        : run.group_id || run.run_mode === 'group'
        ? await executeGroupRun(
            { ...config, ...(sharedSwarmCoordinator ? { swarmCoordinator: sharedSwarmCoordinator } : {}) },
            run,
            scope,
            modelConfig,
            toolRouter,
            signal,
            extras
          )
        : await executeSingleRun(
            { ...config, ...(sharedSwarmCoordinator ? { swarmCoordinator: sharedSwarmCoordinator } : {}) },
            run,
            scope,
            modelConfig,
            toolRouter,
            signal,
            extras
          );
      return { status };
    } catch (error: unknown) {
      if (signal.aborted || isCancellationError(error)) {
        await config.runRepository.setRunCancelled(run.run_id);
        logger.info('Runtime executor cancelled', { runId: run.run_id });
        return { status: 'cancelled' };
      }
      const message = error instanceof Error ? error.message : String(error);
      await config.runRepository.setRunFailed(run.run_id, { code: 'EXECUTOR_ERROR', message });
      logger.error('Runtime executor failed', { runId: run.run_id, error: message });
      return { status: 'failed' };
    }
  };

  return { execute, approvalManager: sharedApprovalManager };
}
