import type { RunRepository } from '../repository/postgres/run-repository.js';
import type { GroupRepository } from '../repository/postgres/group-repository.js';
import type { DelegatedPermissions, RunRecord } from './models.js';
import type { ScopeContext } from './scope.js';
import { generateRunId } from '../../utils/ids.js';
import { ToolError, NotFoundError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

export interface EscalationServiceConfig {
  runRepository: RunRepository;
  groupRepository: GroupRepository;
  /** Default timeout for waiting on child run completion (ms) */
  timeoutMs?: number;
  /** Polling interval for checking child run status (ms) */
  pollIntervalMs?: number;
}

export interface EscalateInput {
  parentRunId: string;
  scope: ScopeContext;
  sessionKey: string;
  groupId?: string;
  goal: string;
  context?: string;
  /** Permissions to delegate to the child group run (Phase C). */
  delegatedPermissions?: DelegatedPermissions;
}

export interface EscalationResult {
  success: boolean;
  childRunId: string;
  result?: string;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 300000; // 5 minutes
const DEFAULT_POLL_INTERVAL_MS = 1000; // 1 second

export class EscalationService {
  private readonly runRepository: RunRepository;
  private readonly groupRepository: GroupRepository;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(config: EscalationServiceConfig) {
    this.runRepository = config.runRepository;
    this.groupRepository = config.groupRepository;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  /**
   * Escalate a task to a group: create a child group run, set parent to waiting,
   * wait for child completion, then resume parent and return the result.
   *
   * When groupId is omitted, auto-selects a suitable group via selectGroup().
   */
  async escalate(input: EscalateInput): Promise<EscalationResult> {
    const { parentRunId, scope, sessionKey, goal, context } = input;

    // Resolve groupId: use provided value or auto-select
    const groupId = input.groupId ?? await this.selectGroup(goal, scope.projectId ?? undefined);

    // Validate group exists and has members
    const group = await this.groupRepository.getGroup(groupId);
    if (!group) {
      throw new NotFoundError('Group', groupId);
    }
    const members = await this.groupRepository.listMembers(groupId);
    if (members.length === 0) {
      throw new ToolError(
        `Group ${groupId} has no members`,
        'escalate_to_group'
      );
    }

    // Build child run input
    const childInput = context
      ? `Goal: ${goal}\n\nContext: ${context}`
      : `Goal: ${goal}`;

    const childRunId = generateRunId();

    // Resolve delegated permissions: explicit > inherited from parent > null
    const parentRun = await this.runRepository.getRunById(parentRunId);
    const delegatedPermissions = input.delegatedPermissions
      ?? parentRun?.delegatedPermissions
      ?? null;

    // Create child group run with parent_run_id and delegated permissions
    await this.runRepository.createRun({
      id: childRunId,
      scope,
      sessionKey,
      input: childInput,
      agentId: 'orchestrator',
      runMode: 'group',
      groupId,
      llmConfig: null,
      parentRunId,
      ...(delegatedPermissions ? { delegatedPermissions } : {}),
    });

    logger.info('Escalation child run created', {
      parentRunId,
      childRunId,
      groupId,
    });

    // Set parent run to waiting
    await this.runRepository.setRunWaiting(parentRunId);
    logger.info('Parent run set to waiting', { parentRunId, childRunId });

    try {
      // Wait for child run to complete
      const childRun = await this.waitForRunCompletion(childRunId);
      const result = this.extractRunResult(childRun);

      // Resume parent run
      await this.runRepository.setRunResumed(parentRunId);
      logger.info('Parent run resumed', { parentRunId, childRunId });

      return result;
    } catch (error) {
      // Resume parent even on failure so it can continue
      await this.runRepository.setRunResumed(parentRunId);
      logger.warn('Escalation failed, parent resumed', {
        parentRunId,
        childRunId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Auto-select a group based on the goal.
   * Phase B simplified strategy: pick the first available group.
   */
  async selectGroup(goal: string, projectId?: string): Promise<string> {
    const groups = await this.groupRepository.listGroups(projectId);
    if (groups.length === 0) {
      throw new ToolError(
        'No available groups to escalate to' +
          (projectId ? ` in project ${projectId}` : ''),
        'escalate_to_group'
      );
    }

    // Phase B: simple first-match selection.
    // Future Phase B+ will use LLM to match goal against group descriptions.
    const selected = groups[0]!;
    logger.info('Auto-selected group for escalation', {
      groupId: selected.id,
      groupName: selected.name,
      goal,
      candidateCount: groups.length,
    });
    return selected.id;
  }

  /**
   * Poll until the run reaches a terminal status or timeout.
   */
  async waitForRunCompletion(runId: string): Promise<RunRecord> {
    const startTime = Date.now();

    while (Date.now() - startTime < this.timeoutMs) {
      const run = await this.runRepository.getRunById(runId);
      if (!run) {
        throw new ToolError(
          `Child run ${runId} not found`,
          'escalate_to_group'
        );
      }

      if (
        run.status === 'completed' ||
        run.status === 'failed' ||
        run.status === 'cancelled'
      ) {
        return run;
      }

      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }

    throw new ToolError(
      `Group run ${runId} did not complete within ${this.timeoutMs}ms`,
      'escalate_to_group'
    );
  }

  /**
   * Extract a user-facing result from a completed child run.
   */
  extractRunResult(run: RunRecord): EscalationResult {
    if (run.status === 'failed') {
      const errorMsg =
        run.error && typeof run.error === 'object' && 'message' in run.error
          ? String(run.error.message)
          : 'Unknown error';
      return {
        success: false,
        childRunId: run.id,
        error: `Group run failed: ${errorMsg}`,
      };
    }

    if (run.status === 'cancelled') {
      return {
        success: false,
        childRunId: run.id,
        error: 'Group run was cancelled',
      };
    }

    const output =
      run.result && typeof run.result === 'object' && 'output' in run.result
        ? String(run.result.output)
        : 'Group completed but produced no output';

    return {
      success: true,
      childRunId: run.id,
      result: output,
    };
  }
}
