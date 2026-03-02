import type { RunRepository } from '../repository/postgres/run-repository.js';
import type { CheckpointService } from './checkpoint-service.js';
import type { RunDependency } from './models.js';
import { logger } from '../../utils/logger.js';

export interface SwarmCoordinatorConfig {
  runRepository: RunRepository;
  checkpointService: CheckpointService;
  enqueueRun: (runId: string) => void;
}

export class SwarmCoordinator {
  private readonly runRepo: RunRepository;
  private readonly checkpointService: CheckpointService;
  private readonly enqueueRun: (runId: string) => void;

  constructor(config: SwarmCoordinatorConfig) {
    this.runRepo = config.runRepository;
    this.checkpointService = config.checkpointService;
    this.enqueueRun = config.enqueueRun;
  }

  async onChildTerminal(
    childRunId: string,
    status: 'completed' | 'failed',
    result?: string,
    error?: string
  ): Promise<void> {
    // Atomically complete dependency and check fan-in
    const outcome = await this.runRepo.completeDependencyAtomic(
      childRunId, status, result, error
    );
    if (!outcome) return; // not a managed child

    const { dep, pendingCount } = outcome;

    logger.info('Child dependency completed', {
      childRunId, parentRunId: dep.parentRunId, status, pendingCount,
    });

    if (pendingCount > 0) return; // siblings still running

    // All children done â€?collect results and wake parent
    const deps = await this.runRepo.listDependenciesByParent(dep.parentRunId);
    await this.injectChildResults(dep.parentRunId, deps);
    await this.runRepo.setRunResumedFromSuspension(dep.parentRunId);
    this.enqueueRun(dep.parentRunId);

    logger.info('Parent run woken after all children completed', {
      parentRunId: dep.parentRunId, childCount: deps.length,
    });
  }

  private async injectChildResults(
    parentRunId: string,
    deps: RunDependency[]
  ): Promise<void> {
    // Find the parent's agent_id from the run record
    const parentRun = await this.runRepo.getRunById(parentRunId);
    if (!parentRun) return;

    const grouped = new Map<string, RunDependency[]>();
    for (const dep of deps) {
      const existing = grouped.get(dep.toolCallId);
      if (existing) {
        existing.push(dep);
        continue;
      }
      grouped.set(dep.toolCallId, [dep]);
    }

    const toolMessages = [...grouped.entries()].map(([toolCallId, groupDeps]) => ({
      role: 'tool' as const,
      content: JSON.stringify({
        child_results: groupDeps.map((dep) => ({
          child_run_id: dep.childRunId,
          role: dep.roleId,
          goal: dep.goal,
          status: dep.status,
          result: dep.result ?? dep.error,
        })),
      }),
      toolCallId,
    }));

    await this.checkpointService.appendToolResults(
      parentRunId, parentRun.agentId, toolMessages
    );
  }
}
