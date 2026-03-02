import type { MemoryScope } from '../../types/memory.js';
import type { MemoryService } from './memory-service.js';
import type { IRunRepository } from '@openintern/repository';
import type { ScopeContext } from './scope.js';
import { logger } from '@openintern/utils';

export interface KnowledgeDepositorConfig {
  memoryService: MemoryService;
  runRepository: IRunRepository;
}

/**
 * Deposits knowledge from completed group runs back into the PA's memory.
 *
 * When a group run completes, the depositor extracts the final output
 * and writes it as an episodic memory scoped to the parent PA run's user,
 * so the PA can recall outcomes of past delegations.
 */
export class KnowledgeDepositor {
  private readonly memoryService: MemoryService;
  private readonly runRepository: IRunRepository;

  constructor(config: KnowledgeDepositorConfig) {
    this.memoryService = config.memoryService;
    this.runRepository = config.runRepository;
  }

  /**
   * Deposit the results of a completed group run into the parent PA's memory.
   *
   * Writes an episodic memory containing:
   *   - The group run's final output (or error summary)
   *   - Metadata linking back to the child and parent run IDs
   *
   * No-ops silently when:
   *   - The run has no parent_run_id (not a delegated run)
   *   - The parent run cannot be found
   */
  async depositGroupResults(
    childRunId: string,
    scope: ScopeContext,
    output: string
  ): Promise<void> {
    const childRun = await this.runRepository.getRunById(childRunId);
    if (!childRun) {
      logger.warn('KnowledgeDepositor: child run not found', { childRunId });
      return;
    }

    const parentRunId = childRun.parentRunId;
    if (!parentRunId) {
      // Not a delegated run; nothing to deposit
      return;
    }

    const memoryScope: MemoryScope = {
      org_id: scope.orgId,
      user_id: scope.userId,
      ...(scope.projectId ? { project_id: scope.projectId } : {}),
    };

    const truncatedOutput = output.length > 2000
      ? output.slice(0, 2000) + '...'
      : output;

    const text = `Group run result (${childRunId}): ${truncatedOutput}`;

    try {
      await this.memoryService.memory_write({
        type: 'episodic',
        scope: memoryScope,
        text,
        metadata: {
          episodic_type: 'GROUP_RESULT',
          child_run_id: childRunId,
          parent_run_id: parentRunId,
          deposited_at: new Date().toISOString(),
        },
        importance: 0.7,
      });

      logger.info('Knowledge deposited from group run', {
        childRunId,
        parentRunId,
      });
    } catch (err) {
      logger.error('Failed to deposit group run knowledge', {
        childRunId,
        parentRunId,
        error: String(err),
      });
    }
  }
}







