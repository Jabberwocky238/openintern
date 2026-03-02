import type { Event, EventType } from '@openintern/types/events.js';
import type { Role } from '@openintern/types/orchestrator.js';
import type { AgentRunner, RunnerContext, RunnerResult } from './agent-runner.js';
import type { RoleRunnerFactory } from './role-runner-factory.js';
import type { ScopeContext } from './scope.js';
import { generateSpanId, generateStepId } from '@openintern/utils';
import { logger } from '@openintern/utils';

// ─── Types ───────────────────────────────────────────────────

export interface OrchestratorMember {
  role: Role;
  agentInstanceId: string;
}

export interface OrchestratorConfig {
  groupId: string;
  members: OrchestratorMember[];
  maxRounds: number;
  runnerFactory: RoleRunnerFactory;
}

export interface OrchestratorContext {
  runId: string;
  sessionKey: string;
  scope: ScopeContext;
  abortSignal?: AbortSignal;
}

export interface OrchestratorResult {
  status: 'completed' | 'failed';
  decision?: string;
  error?: string;
  totalSteps: number;
  rounds: number;
}

// ─── Internal Types ──────────────────────────────────────────

interface RoleSlot {
  member: OrchestratorMember;
  runner: AgentRunner;
}

interface RoundOutput {
  agentId: string;
  roleName: string;
  output: string;
  isLead: boolean;
}

// ─── Orchestrator ────────────────────────────────────────────

/**
 * Serial orchestrator that schedules multiple AgentRunners in round-robin.
 * Each round: non-lead agents run first, then lead synthesizes a DECISION.
 */
export class SerialOrchestrator {
  private readonly slots: RoleSlot[];
  private readonly leadSlot: RoleSlot | null;
  private readonly nonLeadSlots: RoleSlot[];

  constructor(private readonly config: OrchestratorConfig) {
    this.slots = config.members.map((member) => ({
      member,
      runner: config.runnerFactory.create(member.role, member.agentInstanceId),
    }));

    this.leadSlot = this.slots.find((s) => s.member.role.is_lead) ?? null;
    this.nonLeadSlots = this.slots.filter((s) => !s.member.role.is_lead);

    if (this.slots.length === 0) {
      throw new Error('Orchestrator requires at least one member');
    }
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      const err = new Error('Run cancelled by user');
      err.name = 'RunCancelledError';
      throw err;
    }
  }

  async *run(
    input: string,
    ctx: OrchestratorContext
  ): AsyncGenerator<Event, OrchestratorResult, void> {
    const rootSpan = generateSpanId();
    const startedAt = Date.now();
    let totalSteps = 0;

    yield this.createOrchestratorEvent(ctx, generateStepId(0), rootSpan, 'run.started', {
      input,
      config: {
        group_id: this.config.groupId,
        member_count: this.slots.length,
        max_rounds: this.config.maxRounds,
      },
    });

    try {
      const roundOutputs: RoundOutput[] = [];

      for (let round = 1; round <= this.config.maxRounds; round++) {
        this.throwIfAborted(ctx.abortSignal);
        logger.info('Orchestrator round started', {
          runId: ctx.runId,
          groupId: this.config.groupId,
          round,
        });

        // Phase 1: Run non-lead agents
        for (const slot of this.nonLeadSlots) {
          this.throwIfAborted(ctx.abortSignal);
          const agentInput = this.buildAgentInput(input, round, roundOutputs);
          const result = yield* this.runSlot(slot, agentInput, ctx, rootSpan, totalSteps);
          this.throwIfAborted(ctx.abortSignal);
          totalSteps += result.steps;

          if (result.output) {
            roundOutputs.push({
              agentId: slot.member.agentInstanceId,
              roleName: slot.member.role.name,
              output: result.output,
              isLead: false,
            });
          }
        }

        // Phase 2: Run lead agent to synthesize
        if (this.leadSlot) {
          this.throwIfAborted(ctx.abortSignal);
          const leadInput = this.buildLeadInput(input, roundOutputs);
          const result = yield* this.runSlot(this.leadSlot, leadInput, ctx, rootSpan, totalSteps);
          this.throwIfAborted(ctx.abortSignal);
          totalSteps += result.steps;

          if (result.output) {
            roundOutputs.push({
              agentId: this.leadSlot.member.agentInstanceId,
              roleName: this.leadSlot.member.role.name,
              output: result.output,
              isLead: true,
            });

            // Emit DECISION event
            yield this.createOrchestratorEvent(
              ctx,
              generateStepId(totalSteps),
              rootSpan,
              'message.decision',
              {
                decision: result.output,
                rationale: `Synthesized from ${this.nonLeadSlots.length} agent(s) in round ${round}`,
                next_actions: [],
                evidence_refs: [],
              }
            );

            // Lead produced output �?orchestration complete
            yield this.createOrchestratorEvent(
              ctx,
              generateStepId(totalSteps),
              rootSpan,
              'run.completed',
              {
                output: result.output,
                duration_ms: Date.now() - startedAt,
              }
            );

            return {
              status: 'completed',
              decision: result.output,
              totalSteps,
              rounds: round,
            };
          }
        } else {
          // No lead: use last non-lead output as final answer
          const lastOutput = roundOutputs[roundOutputs.length - 1];
          if (lastOutput) {
            yield this.createOrchestratorEvent(
              ctx,
              generateStepId(totalSteps),
              rootSpan,
              'run.completed',
              {
                output: lastOutput.output,
                duration_ms: Date.now() - startedAt,
              }
            );

            return {
              status: 'completed',
              decision: lastOutput.output,
              totalSteps,
              rounds: round,
            };
          }
        }
      }

      throw new Error(`Max rounds (${this.config.maxRounds}) reached without decision`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = ctx.abortSignal?.aborted || /cancel/i.test(message);
      yield this.createOrchestratorEvent(
        ctx,
        generateStepId(Math.max(totalSteps, 1)),
        rootSpan,
        'run.failed',
        {
          error: { code: cancelled ? 'RUN_CANCELLED' : 'ORCHESTRATOR_ERROR', message },
        }
      );
      return {
        status: 'failed',
        error: message,
        totalSteps,
        rounds: 0,
      };
    }
  }

  // ─── Private: run a single slot ────────────────────────────

  private async *runSlot(
    slot: RoleSlot,
    input: string,
    ctx: OrchestratorContext,
    _rootSpan: string,
    _stepOffset: number
  ): AsyncGenerator<Event, RunnerResult, void> {
    const runnerCtx: RunnerContext = {
      runId: ctx.runId,
      sessionKey: ctx.sessionKey,
      scope: ctx.scope,
      agentId: slot.member.agentInstanceId,
      groupId: this.config.groupId,
      agentInstanceId: slot.member.agentInstanceId,
      ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
    };

    logger.info('Running agent slot', {
      runId: ctx.runId,
      agentId: slot.member.agentInstanceId,
      role: slot.member.role.name,
    });

    const gen = slot.runner.run(input, runnerCtx);
    let next = await gen.next();

    while (!next.done) {
      const event = next.value;
      // Tag every event with group_id
      const taggedEvent = {
        ...event,
        group_id: this.config.groupId,
      } as Event;
      yield taggedEvent;
      next = await gen.next();
    }

    return next.value;
  }

  // ─── Private: build inputs ─────────────────────────────────

  private buildAgentInput(
    originalInput: string,
    round: number,
    previousOutputs: RoundOutput[]
  ): string {
    if (round === 1 && previousOutputs.length === 0) {
      return originalInput;
    }

    const context = previousOutputs
      .map((o) => `[${o.roleName}]: ${o.output}`)
      .join('\n\n');

    return `Original task: ${originalInput}\n\nPrevious contributions (round ${round}):\n${context}`;
  }

  private buildLeadInput(
    originalInput: string,
    allOutputs: RoundOutput[]
  ): string {
    const nonLeadOutputs = allOutputs.filter((o) => !o.isLead);

    if (nonLeadOutputs.length === 0) {
      return originalInput;
    }

    const contributions = nonLeadOutputs
      .map((o) => `[${o.roleName}]: ${o.output}`)
      .join('\n\n');

    return [
      `Original task: ${originalInput}`,
      '',
      'Agent contributions to synthesize:',
      contributions,
      '',
      'Please synthesize the above into a final DECISION with rationale.',
    ].join('\n');
  }

  // ─── Private: event factory ────────────────────────────────

  private createOrchestratorEvent<T extends EventType>(
    ctx: OrchestratorContext,
    stepId: string,
    rootSpan: string,
    type: T,
    payload: Extract<Event, { type: T }>['payload']
  ): Extract<Event, { type: T }> {
    return {
      v: 1,
      ts: new Date().toISOString(),
      session_key: ctx.sessionKey,
      run_id: ctx.runId,
      agent_id: 'orchestrator',
      step_id: stepId,
      span_id: generateSpanId(),
      parent_span_id: rootSpan,
      redaction: { contains_secrets: false },
      group_id: this.config.groupId,
      type,
      payload,
    } as Extract<Event, { type: T }>;
  }
}

