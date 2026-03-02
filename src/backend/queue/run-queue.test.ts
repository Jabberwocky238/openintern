/**
 * RunQueue tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { RunQueue } from './run-queue.js';
import type { QueuedRun } from '../../types/api.js';

function createMockRun(overrides: Partial<QueuedRun> = {}): QueuedRun {
  return {
    run_id: `run_${Math.random().toString(36).substring(2, 14)}`,
    org_id: 'org_test',
    user_id: 'user_test',
    session_key: 's_test',
    input: 'test input',
    agent_id: 'main',
    created_at: new Date().toISOString(),
    status: 'pending',
    ...overrides,
  };
}

describe('RunQueue', () => {
  let queue: RunQueue;

  beforeEach(() => {
    queue = new RunQueue({ autoProcess: false });
  });

  describe('enqueue', () => {
    it('should add a run to the queue', () => {
      const run = createMockRun();
      queue.enqueue(run);

      expect(queue.getQueueLength()).toBe(1);
      expect(queue.peek()?.run_id).toBe(run.run_id);
    });

    it('should emit run.enqueued event', () => {
      const run = createMockRun();
      const handler = vi.fn();
      queue.on('run.enqueued', handler);

      queue.enqueue(run);

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        run_id: run.run_id,
        status: 'pending',
      }));
    });

    it('should throw when queue is full', () => {
      const smallQueue = new RunQueue({ maxSize: 2, autoProcess: false });
      smallQueue.enqueue(createMockRun());
      smallQueue.enqueue(createMockRun());

      expect(() => smallQueue.enqueue(createMockRun())).toThrow('Queue is full');
    });
  });

  describe('getStatus', () => {
    it('should return pending for queued runs', () => {
      const run = createMockRun();
      queue.enqueue(run);

      expect(queue.getStatus(run.run_id)).toBe('pending');
    });

    it('should return null for unknown runs', () => {
      expect(queue.getStatus('run_unknown')).toBeNull();
    });
  });

  describe('getRun', () => {
    it('should return the run by ID', () => {
      const run = createMockRun();
      queue.enqueue(run);

      const result = queue.getRun(run.run_id);
      expect(result?.run_id).toBe(run.run_id);
    });

    it('should return null for unknown runs', () => {
      expect(queue.getRun('run_unknown')).toBeNull();
    });
  });

  describe('cancel', () => {
    it('should remove a pending run from queue', () => {
      const run = createMockRun();
      queue.enqueue(run);

      const cancelled = queue.cancel(run.run_id);

      expect(cancelled).toBe(true);
      expect(queue.getQueueLength()).toBe(0);
    });

    it('should return false for unknown runs', () => {
      expect(queue.cancel('run_unknown')).toBe(false);
    });

    it('should cancel a running run via abort signal', async () => {
      queue.setExecutor(async (_run, signal) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 5000);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          }, { once: true });
        });
      });

      const cancelledHandler = vi.fn();
      queue.on('run.cancelled', cancelledHandler);

      const run = createMockRun({ run_id: 'run_cancel_running' });
      queue.enqueue(run);
      const processing = queue.processQueue();

      const started = Date.now();
      while (queue.getStatus(run.run_id) !== 'running') {
        if (Date.now() - started > 3000) {
          throw new Error('Timed out waiting for running status');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(queue.cancel(run.run_id)).toBe(true);
      await processing;

      expect(cancelledHandler).toHaveBeenCalledWith(expect.objectContaining({
        run_id: run.run_id,
        status: 'cancelled',
      }));
      expect(queue.getStatus(run.run_id)).toBe('cancelled');
    });
  });

  describe('processQueue', () => {
    it('should execute runs serially', async () => {
      const executionOrder: string[] = [];
      const executor = vi.fn(async (run: QueuedRun) => {
        executionOrder.push(run.run_id);
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      queue.setExecutor(executor);

      const run1 = createMockRun({ run_id: 'run_first' });
      const run2 = createMockRun({ run_id: 'run_second' });

      queue.enqueue(run1);
      queue.enqueue(run2);

      await queue.processQueue();

      expect(executionOrder).toEqual(['run_first', 'run_second']);
      expect(executor).toHaveBeenCalledTimes(2);
    });

    it('should emit run.started and run.completed events', async () => {
      const startedHandler = vi.fn();
      const completedHandler = vi.fn();

      queue.on('run.started', startedHandler);
      queue.on('run.completed', completedHandler);
      queue.setExecutor(async () => {});

      const run = createMockRun();
      queue.enqueue(run);

      await queue.processQueue();

      expect(startedHandler).toHaveBeenCalledWith(expect.objectContaining({
        run_id: run.run_id,
        status: 'running',
      }));
      expect(completedHandler).toHaveBeenCalledWith(expect.objectContaining({
        run_id: run.run_id,
        status: 'completed',
      }));
    });

    it('should emit run.failed on executor error', async () => {
      const failedHandler = vi.fn();
      queue.on('run.failed', failedHandler);
      queue.setExecutor(() => {
        return Promise.reject(new Error('Test error'));
      });

      const run = createMockRun();
      queue.enqueue(run);

      await queue.processQueue();

      expect(failedHandler).toHaveBeenCalledWith(expect.objectContaining({
        run_id: run.run_id,
        status: 'failed',
      }));
    });

    it('should continue processing after a run fails', async () => {
      const completedHandler = vi.fn();
      queue.on('run.completed', completedHandler);

      let callCount = 0;
      queue.setExecutor(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error('First run fails'));
        }
        return Promise.resolve();
      });

      queue.enqueue(createMockRun());
      queue.enqueue(createMockRun());

      await queue.processQueue();

      expect(completedHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe('timeout', () => {
    it('should fail run on timeout', async () => {
      const timeoutQueue = new RunQueue({
        autoProcess: false,
        timeoutMs: 50,
      });

      const failedHandler = vi.fn();
      timeoutQueue.on('run.failed', failedHandler);

      timeoutQueue.setExecutor(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
      });

      const run = createMockRun();
      timeoutQueue.enqueue(run);

      await timeoutQueue.processQueue();

      expect(failedHandler).toHaveBeenCalled();
    });
  });

  describe('getPendingRuns', () => {
    it('should return all pending runs', () => {
      const run1 = createMockRun();
      const run2 = createMockRun();

      queue.enqueue(run1);
      queue.enqueue(run2);

      const pending = queue.getPendingRuns();

      expect(pending).toHaveLength(2);
      expect(pending[0]?.run_id).toBe(run1.run_id);
      expect(pending[1]?.run_id).toBe(run2.run_id);
    });
  });

  describe('isEmpty', () => {
    it('should return true when queue is empty', () => {
      expect(queue.isEmpty()).toBe(true);
    });

    it('should return false when queue has items', () => {
      queue.enqueue(createMockRun());
      expect(queue.isEmpty()).toBe(false);
    });
  });

  describe('persistence', () => {
    const persistDir = '/tmp/test-queue-persist-' + Date.now();

    afterEach(async () => {
      await fs.promises.rm(persistDir, { recursive: true, force: true });
    });

    it('should persist enqueued runs to JSONL file', async () => {
      const pQueue = new RunQueue({ autoProcess: false, persistDir });
      const run = createMockRun({ run_id: 'run_persist1' });
      pQueue.enqueue(run);

      const content = await fs.promises.readFile(
        `${persistDir}/queue.jsonl`, 'utf-8',
      );
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(1);

      const parsed = JSON.parse(lines[0]!) as QueuedRun;
      expect(parsed.run_id).toBe('run_persist1');
    });

    it('should restore pending runs from disk', async () => {
      // Write a JSONL file manually
      await fs.promises.mkdir(persistDir, { recursive: true });
      const runs = [
        JSON.stringify(createMockRun({ run_id: 'run_r1', status: 'pending' })),
        JSON.stringify(createMockRun({ run_id: 'run_r2', status: 'pending' })),
        JSON.stringify(createMockRun({ run_id: 'run_done', status: 'completed' })),
      ];
      await fs.promises.writeFile(
        `${persistDir}/queue.jsonl`,
        runs.join('\n') + '\n',
        'utf-8',
      );

      const pQueue = new RunQueue({ autoProcess: false, persistDir });
      const restored = await pQueue.restore();

      expect(restored).toBe(2);
      expect(pQueue.getQueueLength()).toBe(2);
      expect(pQueue.getStatus('run_r1')).toBe('pending');
      expect(pQueue.getStatus('run_done')).toBeNull();
    });

    it('should return 0 when no persist file exists', async () => {
      const pQueue = new RunQueue({ autoProcess: false, persistDir });
      const restored = await pQueue.restore();
      expect(restored).toBe(0);
    });

    it('should rewrite file after run completes', async () => {
      const pQueue = new RunQueue({ autoProcess: false, persistDir });
      pQueue.setExecutor(async () => {});

      pQueue.enqueue(createMockRun({ run_id: 'run_x1' }));
      pQueue.enqueue(createMockRun({ run_id: 'run_x2' }));

      await pQueue.processQueue();

      const content = await fs.promises.readFile(
        `${persistDir}/queue.jsonl`, 'utf-8',
      );
      // Both runs completed, file should be empty
      expect(content.trim()).toBe('');
    });
  });

  describe('waiting / resume (nested runs)', () => {
    it('should move a running run to waiting state', async () => {
      let resolveExecutor: (() => void) | undefined;
      queue.setExecutor(async () => {
        await new Promise<void>((resolve) => {
          resolveExecutor = resolve;
        });
      });

      const run = createMockRun({ run_id: 'run_waitparent1' });
      queue.enqueue(run);
      const processing = queue.processQueue();

      // Wait for run to start
      const started = Date.now();
      while (queue.getStatus(run.run_id) !== 'running') {
        if (Date.now() - started > 3000) throw new Error('Timed out waiting for running');
        await new Promise((r) => setTimeout(r, 10));
      }

      const waitingHandler = vi.fn();
      queue.on('run.waiting', waitingHandler);

      queue.notifyRunWaiting(run.run_id);

      expect(queue.getStatus(run.run_id)).toBe('waiting');
      expect(queue.getCurrentRun()).toBeNull();
      expect(queue.getWaitingRuns()).toHaveLength(1);
      expect(waitingHandler).toHaveBeenCalledWith(
        expect.objectContaining({ run_id: run.run_id, status: 'waiting' })
      );

      // Resolve the executor so processQueue finishes
      resolveExecutor?.();
      await processing;
    });

    it('should allow a child run to execute while parent is waiting', async () => {
      // Use autoProcess: false for deterministic control
      const nestedQueue = new RunQueue({ autoProcess: false });
      const executionOrder: string[] = [];
      let parentResolve: (() => void) | undefined;

      nestedQueue.setExecutor(async (run) => {
        executionOrder.push(run.run_id);
        if (run.run_id === 'run_parentwait1') {
          // Simulate parent entering waiting state
          nestedQueue.notifyRunWaiting(run.run_id);
          await new Promise<void>((resolve) => {
            parentResolve = resolve;
          });
        }
        // Child runs complete immediately
      });

      const parent = createMockRun({ run_id: 'run_parentwait1' });
      const child = createMockRun({ run_id: 'run_childexec01' });

      nestedQueue.enqueue(parent);
      nestedQueue.enqueue(child);

      // Start processing -- this will execute parent, which enters waiting
      const parentProcessing = nestedQueue.processQueue();

      // Wait for parent to enter waiting state
      const started = Date.now();
      while (nestedQueue.getStatus('run_parentwait1') !== 'waiting') {
        if (Date.now() - started > 3000) throw new Error('Timed out waiting for waiting state');
        await new Promise((r) => setTimeout(r, 10));
      }

      // Parent is waiting, queue should be released. Process child.
      const childProcessing = nestedQueue.processQueue();
      await childProcessing;

      expect(nestedQueue.getStatus('run_childexec01')).toBe('completed');
      expect(executionOrder).toContain('run_parentwait1');
      expect(executionOrder).toContain('run_childexec01');

      // Resume parent
      nestedQueue.notifyRunResumed('run_parentwait1');
      parentResolve?.();
      await parentProcessing;

      expect(nestedQueue.getStatus('run_parentwait1')).toBe('completed');
    });

    it('should remove run from waiting set on resume', async () => {
      let resolveExecutor: (() => void) | undefined;
      queue.setExecutor(async () => {
        await new Promise<void>((resolve) => {
          resolveExecutor = resolve;
        });
      });

      const run = createMockRun({ run_id: 'run_resumetest' });
      queue.enqueue(run);
      const processing = queue.processQueue();

      const started = Date.now();
      while (queue.getStatus(run.run_id) !== 'running') {
        if (Date.now() - started > 3000) throw new Error('Timed out');
        await new Promise((r) => setTimeout(r, 10));
      }

      queue.notifyRunWaiting(run.run_id);
      expect(queue.getWaitingRuns()).toHaveLength(1);

      const resumedHandler = vi.fn();
      queue.on('run.resumed', resumedHandler);

      queue.notifyRunResumed(run.run_id);
      expect(queue.getWaitingRuns()).toHaveLength(0);
      expect(resumedHandler).toHaveBeenCalledWith(
        expect.objectContaining({ run_id: run.run_id, status: 'running' })
      );

      resolveExecutor?.();
      await processing;
    });

    it('should not emit warning when notifyRunWaiting called for non-running run', () => {
      // Should not throw, just log a warning
      queue.notifyRunWaiting('run_nonexistent');
      expect(queue.getWaitingRuns()).toHaveLength(0);
    });

    it('should not emit warning when notifyRunResumed called for non-waiting run', () => {
      // Should not throw, just log a warning
      queue.notifyRunResumed('run_nonexistent');
    });

    it('should include waiting runs in isEmpty check', async () => {
      let resolveExecutor: (() => void) | undefined;
      queue.setExecutor(async () => {
        await new Promise<void>((resolve) => {
          resolveExecutor = resolve;
        });
      });

      const run = createMockRun({ run_id: 'run_emptycheck1' });
      queue.enqueue(run);
      const processing = queue.processQueue();

      const started = Date.now();
      while (queue.getStatus(run.run_id) !== 'running') {
        if (Date.now() - started > 3000) throw new Error('Timed out');
        await new Promise((r) => setTimeout(r, 10));
      }

      queue.notifyRunWaiting(run.run_id);

      // Queue has no pending or running runs, but has a waiting run
      expect(queue.isEmpty()).toBe(false);

      resolveExecutor?.();
      await processing;
    });
  });
});

