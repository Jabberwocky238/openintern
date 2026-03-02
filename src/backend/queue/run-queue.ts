/**
 * RunQueue - Memory queue for serial run execution
 *
 * Features:
 * - Run-level serial execution (one run at a time)
 * - Queue management: enqueue, dequeue, peek
 * - Status tracking: pending, running, waiting, completed, failed
 * - Event emission for queue state changes
 * - Nested run support: waiting runs release the queue for child runs
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { QueuedRun } from '../../types/api.js';
import { logger } from '../../utils/logger.js';

/**
 * Queue event types
 */
export type QueueEventType =
  | 'run.enqueued'
  | 'run.started'
  | 'run.completed'
  | 'run.cancelled'
  | 'run.failed'
  | 'run.waiting'
  | 'run.resumed'
  | 'queue.empty';

/**
 * Queue event handler type
 */
export type QueueEventHandler = (run: QueuedRun) => void;

/**
 * Run executor function type
 */
export type RunExecutor = (
  run: QueuedRun,
  signal: AbortSignal
) => Promise<{ status: 'completed' | 'failed' | 'cancelled' | 'suspended' } | void>;

/**
 * Queue configuration
 */
export interface QueueConfig {
  /** Maximum queue size (0 = unlimited) */
  maxSize: number;
  /** Run execution timeout in milliseconds */
  timeoutMs: number;
  /** Whether to auto-process queue */
  autoProcess: boolean;
  /** Base directory for JSONL persistence (null = no persistence) */
  persistDir: string | null;
}

const DEFAULT_CONFIG: QueueConfig = {
  maxSize: 100,
  timeoutMs: 300000, // 5 minutes
  autoProcess: true,
  persistDir: null,
};

/**
 * RunQueue class for managing run execution
 */
export class RunQueue extends EventEmitter {
  private queue: QueuedRun[] = [];
  private runningRun: QueuedRun | null = null;
  private completedRuns: Map<string, QueuedRun> = new Map();
  /** Runs that are in 'waiting' state (parent waiting for child) */
  private waitingRuns: Map<string, QueuedRun> = new Map();
  private config: QueueConfig;
  private executor: RunExecutor | null = null;
  private processing = false;
  private persistPath: string | null = null;
  private currentAbortController: AbortController | null = null;

  constructor(config: Partial<QueueConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (this.config.persistDir) {
      this.persistPath = path.join(this.config.persistDir, 'queue.jsonl');
    }
  }

  /**
   * Set the run executor function
   */
  setExecutor(executor: RunExecutor): void {
    this.executor = executor;
  }

  /**
   * Enqueue a new run
   */
  enqueue(run: QueuedRun): void {
    // Check queue size limit
    if (this.config.maxSize > 0 && this.queue.length >= this.config.maxSize) {
      throw new Error(`Queue is full (max: ${this.config.maxSize})`);
    }

    // Ensure status is pending
    const queuedRun: QueuedRun = {
      ...run,
      status: 'pending',
    };

    this.queue.push(queuedRun);
    this.persistAppend(queuedRun);
    this.emit('run.enqueued', queuedRun);
    logger.info('Run enqueued', { runId: run.run_id, queueLength: this.queue.length });

    // Auto-process if enabled
    if (this.config.autoProcess && !this.processing) {
      void this.processQueue();
    }
  }

  /**
   * Dequeue the next run (internal use)
   */
  private dequeue(): QueuedRun | null {
    return this.queue.shift() ?? null;
  }

  /**
   * Peek at the next run without removing it
   */
  peek(): QueuedRun | null {
    return this.queue[0] ?? null;
  }

  /**
   * Get the status of a run by ID
   */
  getStatus(runId: string): QueuedRun['status'] | null {
    // Check if currently running
    if (this.runningRun?.run_id === runId) {
      return 'running';
    }

    // Check waiting runs
    const waiting = this.waitingRuns.get(runId);
    if (waiting) {
      return 'waiting';
    }

    // Check completed runs
    const completed = this.completedRuns.get(runId);
    if (completed) {
      return completed.status;
    }

    // Check queue
    const queued = this.queue.find((r) => r.run_id === runId);
    if (queued) {
      return 'pending';
    }

    return null;
  }

  /**
   * Get full run info by ID
   */
  getRun(runId: string): QueuedRun | null {
    // Check if currently running
    if (this.runningRun?.run_id === runId) {
      return this.runningRun;
    }

    // Check waiting runs
    const waiting = this.waitingRuns.get(runId);
    if (waiting) {
      return waiting;
    }

    // Check completed runs
    const completed = this.completedRuns.get(runId);
    if (completed) {
      return completed;
    }

    // Check queue
    const queued = this.queue.find((r) => r.run_id === runId);
    if (queued) {
      return queued;
    }

    return null;
  }

  /**
   * Get queue length
   */
  getQueueLength(): number {
    return this.queue.length;
  }

  /**
   * Check if queue is empty
   */
  isEmpty(): boolean {
    return this.queue.length === 0 && this.runningRun === null && this.waitingRuns.size === 0;
  }

  /**
   * Check if a run is currently executing
   */
  isProcessing(): boolean {
    return this.processing;
  }

  /**
   * Get the currently running run
   */
  getCurrentRun(): QueuedRun | null {
    return this.runningRun;
  }

  /**
   * Get all waiting runs
   */
  getWaitingRuns(): QueuedRun[] {
    return Array.from(this.waitingRuns.values());
  }

  /**
   * Notify the queue that a run has entered 'waiting' state.
   * This releases the queue lock so the next pending run can start.
   */
  notifyRunWaiting(runId: string): void {
    if (this.runningRun?.run_id !== runId) {
      logger.warn('notifyRunWaiting called for non-running run', { runId });
      return;
    }

    const waitingRun: QueuedRun = {
      ...this.runningRun,
      status: 'waiting',
    };
    this.waitingRuns.set(runId, waitingRun);
    this.runningRun = null;
    this.currentAbortController = null;
    this.emit('run.waiting', waitingRun);
    logger.info('Run entered waiting state, queue released', { runId });

    // Trigger processing of next queued run on next event loop tick.
    // We use setTimeout(0) rather than queueMicrotask because the caller
    // may be inside an executor whose processQueue frame is still on the stack.
    if (this.queue.length > 0) {
      this.processing = false;
      setTimeout(() => {
        void this.processQueue();
      }, 0);
    }
  }

  /**
   * Notify the queue that a waiting run has been resumed.
   * The run is removed from the waiting set. It does not re-enter the queue;
   * the executor promise that originally started it is still alive and will
   * continue running once the escalation service resolves.
   */
  notifyRunResumed(runId: string): void {
    const waiting = this.waitingRuns.get(runId);
    if (!waiting) {
      logger.warn('notifyRunResumed called for non-waiting run', { runId });
      return;
    }

    this.waitingRuns.delete(runId);
    this.emit('run.resumed', { ...waiting, status: 'running' });
    logger.info('Waiting run resumed', { runId });
  }

  /**
   * Process the queue (execute runs serially)
   */
  async processQueue(): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;

    try {
      while (this.queue.length > 0) {
        // Only start a new run if nothing is currently running
        // (waiting runs don't block the queue)
        if (this.runningRun !== null) {
          break;
        }

        const run = this.dequeue();
        if (!run) {
          break;
        }

        await this.executeRun(run);
      }

      if (this.queue.length === 0 && this.runningRun === null && this.waitingRuns.size === 0) {
        this.emit('queue.empty', null);
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Execute a single run with timeout
   */
  private async executeRun(run: QueuedRun): Promise<void> {
    const abortController = new AbortController();
    this.currentAbortController = abortController;

    // Update status to running
    const runningRun: QueuedRun = {
      ...run,
      status: 'running',
    };
    this.runningRun = runningRun;
    this.emit('run.started', runningRun);
    logger.info('Run started', { runId: run.run_id });

    try {
      let finalStatus: 'completed' | 'failed' | 'cancelled' | 'suspended' = 'completed';
      if (this.executor) {
        // Execute with timeout
        const result = await Promise.race([
          this.executor(runningRun, abortController.signal),
          this.createTimeout(run.run_id),
        ]);
        if (result && typeof result === 'object' && 'status' in result) {
          finalStatus = result.status;
        } else if (abortController.signal.aborted) {
          finalStatus = 'cancelled';
        }
      }

      if (finalStatus === 'cancelled') {
        const cancelledRun: QueuedRun = {
          ...runningRun,
          status: 'cancelled',
        };
        this.completedRuns.set(run.run_id, cancelledRun);
        this.emit('run.cancelled', cancelledRun);
        logger.info('Run cancelled while running', { runId: run.run_id });
      } else if (finalStatus === 'suspended') {
        // Run suspended to disk â€?don't track in completedRuns, it will be re-enqueued on resume
        logger.info('Run suspended to disk', { runId: run.run_id });
      } else if (finalStatus === 'failed') {
        const failedRun: QueuedRun = {
          ...runningRun,
          status: 'failed',
        };
        this.completedRuns.set(run.run_id, failedRun);
        this.emit('run.failed', failedRun);
        logger.error('Run failed', { runId: run.run_id });
      } else {
        // Mark as completed
        const completedRun: QueuedRun = {
          ...runningRun,
          status: 'completed',
        };
        this.completedRuns.set(run.run_id, completedRun);
        this.emit('run.completed', completedRun);
        logger.info('Run completed', { runId: run.run_id });
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        const cancelledRun: QueuedRun = {
          ...runningRun,
          status: 'cancelled',
        };
        this.completedRuns.set(run.run_id, cancelledRun);
        this.emit('run.cancelled', cancelledRun);
        logger.info('Run cancelled while running', { runId: run.run_id });
        return;
      }

      // Mark as failed
      const failedRun: QueuedRun = {
        ...runningRun,
        status: 'failed',
      };
      this.completedRuns.set(run.run_id, failedRun);
      this.emit('run.failed', failedRun);
      logger.error('Run failed', {
        runId: run.run_id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.currentAbortController = null;
      // Only clear runningRun if it hasn't been moved to waiting
      if (this.runningRun?.run_id === run.run_id) {
        this.runningRun = null;
      }
      this.persistRewrite();
    }
  }

  /**
   * Create a timeout promise
   */
  private createTimeout(runId: string): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Run ${runId} timed out after ${this.config.timeoutMs}ms`));
      }, this.config.timeoutMs);
    });
  }

  /**
   * Clear completed runs from memory
   */
  clearCompleted(): void {
    this.completedRuns.clear();
  }

  /**
   * Cancel a pending run (remove from queue)
   */
  cancel(runId: string): boolean {
    if (this.runningRun?.run_id === runId && this.currentAbortController) {
      this.currentAbortController.abort();
      logger.info('Running run cancellation requested', { runId });
      return true;
    }

    const index = this.queue.findIndex((r) => r.run_id === runId);
    if (index === -1) {
      return false;
    }

    this.queue.splice(index, 1);
    this.persistRewrite();
    logger.info('Run cancelled', { runId });
    return true;
  }

  /**
   * Get all pending runs
   */
  getPendingRuns(): QueuedRun[] {
    return [...this.queue];
  }

  /**
   * Get all completed runs
   */
  getCompletedRuns(): QueuedRun[] {
    return Array.from(this.completedRuns.values());
  }

  /**
   * Append a single run to the JSONL persistence file
   */
  private persistAppend(run: QueuedRun): void {
    if (!this.persistPath) return;
    try {
      const dir = path.dirname(this.persistPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(this.persistPath, JSON.stringify(run) + '\n', 'utf-8');
    } catch (err) {
      logger.warn('Failed to persist queue append', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Rewrite the entire JSONL file with current pending queue
   */
  private persistRewrite(): void {
    if (!this.persistPath) return;
    try {
      const dir = path.dirname(this.persistPath);
      fs.mkdirSync(dir, { recursive: true });
      const lines = this.queue.map((r) => JSON.stringify(r)).join('\n');
      const content = lines ? lines + '\n' : '';
      const tmpPath = this.persistPath + '.tmp';
      fs.writeFileSync(tmpPath, content, 'utf-8');
      fs.renameSync(tmpPath, this.persistPath);
    } catch (err) {
      logger.warn('Failed to persist queue rewrite', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Restore pending runs from JSONL file on startup.
   * Only restores runs with status 'pending' or 'running' (treated as pending).
   */
  async restore(): Promise<number> {
    if (!this.persistPath) return 0;
    try {
      const content = await fs.promises.readFile(this.persistPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      let restored = 0;

      for (const line of lines) {
        try {
          const run = JSON.parse(line) as QueuedRun;
          if (run.status === 'pending' || run.status === 'running' || run.status === 'suspended') {
            run.status = 'pending';
            this.queue.push(run);
            restored++;
          }
        } catch {
          // Skip malformed lines
        }
      }

      if (restored > 0) {
        logger.info('Queue restored from disk', { restored });
        this.persistRewrite();
      }
      return restored;
    } catch (err) {
      if (
        err instanceof Error &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return 0;
      }
      logger.warn('Failed to restore queue', {
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }
}

