import type { LLMConfig } from '../../types/agent.js';
import type { Role } from '../../types/orchestrator.js';
import { SingleAgentRunner, type AgentRunner, type SingleAgentRunnerConfig } from './agent-runner.js';
import { CheckpointService } from './checkpoint-service.js';
import { CompactionService } from './compaction-service.js';
import { MemoryService } from './memory-service.js';
import type { DelegatedPermissions } from './models.js';
import { PromptComposer, type SkillInjection } from './prompt-composer.js';
import { RuntimeToolRouter } from './tool-router.js';
import { TokenBudgetManager } from './token-budget-manager.js';
import { ToolCallScheduler } from './tool-scheduler.js';
import { ToolPolicy } from './tool-policy.js';

export interface RoleRunnerFactoryConfig {
  maxSteps: number;
  modelConfig: LLMConfig;
  checkpointService: CheckpointService;
  memoryService: MemoryService;
  toolRouter: RuntimeToolRouter;
  toolScheduler?: ToolCallScheduler;
  skillInjections?: SkillInjection[];
  workDir?: string;
  budget?: {
    maxContextTokens?: number;
    compactionThreshold?: number;
    warningThreshold?: number;
    reserveTokens?: number;
  };
  /** Delegated permissions from parent PA run (Phase C). */
  delegatedPermissions?: DelegatedPermissions;
}

/**
 * Factory that creates AgentRunner instances from Role definitions.
 * Each role gets its own system prompt injected into the runner.
 */
export class RoleRunnerFactory {
  constructor(private readonly config: RoleRunnerFactoryConfig) {}

  create(role: Role, agentId?: string): AgentRunner {
    const systemPrompt = this.buildRolePrompt(role);
    const agentContext = ToolPolicy.contextFromRole(
      role,
      agentId ?? role.id,
      this.config.delegatedPermissions
    );

    const promptComposer = new PromptComposer({
      basePrompt: systemPrompt,
      ...(this.config.modelConfig.provider !== 'mock'
        && { provider: this.config.modelConfig.provider }),
    });

    const budgetManager = this.config.budget
      ? new TokenBudgetManager(this.config.budget)
      : undefined;

    const compactionService = budgetManager
      ? new CompactionService()
      : undefined;

    const runnerConfig: SingleAgentRunnerConfig = {
      maxSteps: this.config.maxSteps,
      modelConfig: this.config.modelConfig,
      checkpointService: this.config.checkpointService,
      memoryService: this.config.memoryService,
      toolRouter: this.config.toolRouter,
      systemPrompt,
      agentContext,
      promptComposer,
      ...(this.config.toolScheduler ? { toolScheduler: this.config.toolScheduler } : {}),
      ...(budgetManager ? { budgetManager } : {}),
      ...(compactionService ? { compactionService } : {}),
      ...(this.config.skillInjections ? { skillInjections: this.config.skillInjections } : {}),
      ...(this.config.workDir ? { workDir: this.config.workDir } : {}),
    };

    return new SingleAgentRunner(runnerConfig);
  }

  private buildRolePrompt(role: Role): string {
    const lines: string[] = [role.system_prompt];

    if (role.is_lead) {
      lines.push('');
      lines.push('You are the LEAD of this group. Your responsibilities:');
      lines.push('- Synthesize proposals and evidence from other agents');
      lines.push('- Make final DECISION with rationale');
      lines.push('- Coordinate next actions');
    }

    lines.push('');
    lines.push('Communication protocol:');
    lines.push('- Structure your output with a clear message_type');
    lines.push('- Use PROPOSAL to suggest plans');
    lines.push('- Use EVIDENCE to provide supporting data');
    lines.push('- Use STATUS to report progress');
    if (role.is_lead) {
      lines.push('- Use DECISION to make final calls');
    }

    return lines.join('\n');
  }
}

