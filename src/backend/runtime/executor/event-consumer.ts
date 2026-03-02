import type { Event } from '../../../types/events.js';
import type { RuntimeExecutorConfig } from '../executor.js';
import { EpisodicGenerator } from '../episodic-generator.js';
import { KnowledgeDepositor } from '../knowledge-depositor.js';
import { logger } from '../../../utils/logger.js';

type Scope = { orgId: string; userId: string; projectId: string | null };
type RunTerminalStatus = 'completed' | 'failed' | 'cancelled' | 'suspended';

const TOKEN_EVENT_BATCH_SIZE = 24;

export async function consumeEventStream(
  config: RuntimeExecutorConfig,
  runId: string,
  stream: AsyncGenerator<Event, unknown, void>,
  signal: AbortSignal,
  groupId?: string,
  scope?: Scope
): Promise<RunTerminalStatus | null> {
  let tokenBuffer: Event[] = [];
  let terminalStatus: RunTerminalStatus | null = null;
  const persistLlmTokens = config.persistLlmTokens === true;

  const flushTokens = async (): Promise<void> => {
    if (tokenBuffer.length === 0) return;
    await config.eventService.writeBatch(tokenBuffer);
    tokenBuffer = [];
  };

  for await (const event of stream) {
    if (event.type === 'llm.token') {
      config.sseManager.broadcastToRun(runId, event);
      if (persistLlmTokens) {
        tokenBuffer.push(event);
        if (tokenBuffer.length >= TOKEN_EVENT_BATCH_SIZE) {
          await flushTokens();
        }
      }
      continue;
    }

    await flushTokens();
    const status = await processEvent(config, runId, event, groupId, scope);
    if (status) terminalStatus = status;
    if (signal.aborted && terminalStatus === null) terminalStatus = 'cancelled';
  }

  await flushTokens();
  return terminalStatus;
}

async function processEvent(
  config: RuntimeExecutorConfig,
  runId: string,
  event: Event,
  groupId?: string,
  scope?: Scope
): Promise<RunTerminalStatus | null> {
  await config.eventService.write(event);
  config.sseManager.broadcastToRun(runId, event);

  if (event.type === 'run.completed') {
    await config.runRepository.setRunCompleted(runId, event.payload.output);

    if (groupId && scope) {
      try {
        const generator = new EpisodicGenerator(config.memoryService, config.eventService);
        await generator.generateFromRun(runId, groupId, scope);
      } catch (err) {
        logger.error('Failed to generate episodic memories', {
          runId, groupId, error: String(err),
        });
      }

      try {
        const depositor = new KnowledgeDepositor({
          memoryService: config.memoryService,
          runRepository: config.runRepository,
        });
        await depositor.depositGroupResults(runId, scope, event.payload.output ?? '');
      } catch (err) {
        logger.error('Failed to deposit group run knowledge', {
          runId, groupId, error: String(err),
        });
      }
    }

    // Check if this child completion should wake a parent
    if (config.swarmCoordinator) {
      try {
        await config.swarmCoordinator.onChildTerminal(
          runId, 'completed', event.payload.output
        );
      } catch (err) {
        logger.error('SwarmCoordinator failed on child completed', {
          runId, error: String(err),
        });
      }
    }

    return 'completed';
  }

  if (event.type === 'run.suspended') {
    // Runs (including delegated child runs) stay suspended and wait for
    // explicit human approval/rejection via /runs/:run_id/approve|reject.
    return 'suspended';
  }

  if (event.type === 'run.failed') {
    if (event.payload.error.code === 'RUN_CANCELLED') {
      await config.runRepository.setRunCancelled(runId);
      return 'cancelled';
    }
    await config.runRepository.setRunFailed(runId, {
      code: event.payload.error.code,
      message: event.payload.error.message,
    });

    // Check if this child failure should wake a parent
    if (config.swarmCoordinator) {
      try {
        await config.swarmCoordinator.onChildTerminal(
          runId, 'failed', undefined, event.payload.error.message
        );
      } catch (err) {
        logger.error('SwarmCoordinator failed on child failed', {
          runId, error: String(err),
        });
      }
    }

    return 'failed';
  }

  return null;
}

