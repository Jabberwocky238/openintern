/**
 * ProjectionStore tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ProjectionStore } from './projection-store.js';
import { EventStore } from './event-store.js';
import type {
  RunStartedEvent,
  RunCompletedEvent,
  RunFailedEvent,
  ToolCalledEvent,
  ToolResultEvent,
} from '@openintern/types/events.js';

describe('ProjectionStore', () => {
  let tempDir: string;
  let store: ProjectionStore;
  let eventStore: EventStore;

  const sessionKey = 's_test';
  const runId = 'run_abc123';

  const createRunStartedEvent = (): RunStartedEvent => ({
    v: 1,
    ts: '2026-02-05T10:00:00.000Z',
    session_key: sessionKey,
    run_id: runId,
    agent_id: 'main',
    step_id: 'step_0001',
    span_id: 'sp_start1',
    parent_span_id: null,
    type: 'run.started',
    payload: {
      input: 'test input',
    },
    redaction: {
      contains_secrets: false,
    },
  });

  const createRunCompletedEvent = (): RunCompletedEvent => ({
    v: 1,
    ts: '2026-02-05T10:05:00.000Z',
    session_key: sessionKey,
    run_id: runId,
    agent_id: 'main',
    step_id: 'step_0010',
    span_id: 'sp_end1',
    parent_span_id: null,
    type: 'run.completed',
    payload: {
      output: 'test output',
      duration_ms: 300000,
    },
    redaction: {
      contains_secrets: false,
    },
  });

  const createRunFailedEvent = (): RunFailedEvent => ({
    v: 1,
    ts: '2026-02-05T10:03:00.000Z',
    session_key: sessionKey,
    run_id: runId,
    agent_id: 'main',
    step_id: 'step_0005',
    span_id: 'sp_fail1',
    parent_span_id: null,
    type: 'run.failed',
    payload: {
      error: {
        code: 'TEST_ERROR',
        message: 'Test error message',
      },
    },
    redaction: {
      contains_secrets: false,
    },
  });

  const createToolCalledEvent = (stepNum: number): ToolCalledEvent => ({
    v: 1,
    ts: new Date().toISOString(),
    session_key: sessionKey,
    run_id: runId,
    agent_id: 'main',
    step_id: `step_${String(stepNum).padStart(4, '0')}`,
    span_id: `sp_tool${stepNum}`,
    parent_span_id: 'sp_start1',
    type: 'tool.called',
    payload: {
      toolName: 'test_tool',
      args: { query: `test ${stepNum}` },
    },
    redaction: {
      contains_secrets: false,
    },
  });

  const createToolResultEvent = (stepNum: number): ToolResultEvent => ({
    v: 1,
    ts: new Date().toISOString(),
    session_key: sessionKey,
    run_id: runId,
    agent_id: 'main',
    step_id: `step_${String(stepNum).padStart(4, '0')}`,
    span_id: `sp_result${stepNum}`,
    parent_span_id: `sp_tool${stepNum}`,
    type: 'tool.result',
    payload: {
      toolName: 'test_tool',
      result: { data: 'test result' },
      isError: false,
    },
    redaction: {
      contains_secrets: false,
    },
  });

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'projection-store-test-')
    );
    store = new ProjectionStore(sessionKey, runId, tempDir);
    eventStore = new EventStore(sessionKey, runId, tempDir);
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe('generateRunMeta', () => {
    it('should generate meta from events', async () => {
      // Add events
      await eventStore.append(createRunStartedEvent());
      await eventStore.append(createToolCalledEvent(2));
      await eventStore.append(createToolResultEvent(2));
      await eventStore.append(createToolCalledEvent(3));
      await eventStore.append(createToolResultEvent(3));
      await eventStore.append(createRunCompletedEvent());

      const meta = await store.generateRunMeta();

      expect(meta.run_id).toBe(runId);
      expect(meta.session_key).toBe(sessionKey);
      expect(meta.status).toBe('completed');
      expect(meta.event_count).toBe(6);
      expect(meta.tool_call_count).toBe(2);
      expect(meta.duration_ms).toBe(300000);
    });

    it('should handle running status', async () => {
      await eventStore.append(createRunStartedEvent());
      await eventStore.append(createToolCalledEvent(2));

      const meta = await store.generateRunMeta();

      expect(meta.status).toBe('running');
      expect(meta.ended_at).toBeNull();
      expect(meta.duration_ms).toBeNull();
    });

    it('should handle failed status', async () => {
      await eventStore.append(createRunStartedEvent());
      await eventStore.append(createRunFailedEvent());

      const meta = await store.generateRunMeta();

      expect(meta.status).toBe('failed');
      expect(meta.ended_at).toBe('2026-02-05T10:03:00.000Z');
    });

    it('should handle empty events', async () => {
      const meta = await store.generateRunMeta();

      expect(meta.status).toBe('pending');
      expect(meta.event_count).toBe(0);
      expect(meta.tool_call_count).toBe(0);
    });

    it('should save meta to file', async () => {
      await eventStore.append(createRunStartedEvent());
      await store.generateRunMeta();

      const exists = await store.exists();
      expect(exists).toBe(true);
    });
  });

  describe('updateRunMeta', () => {
    it('should create meta on first event', async () => {
      const event = createRunStartedEvent();
      await store.updateRunMeta(event);

      const meta = await store.loadRunMeta();
      expect(meta).not.toBeNull();
      expect(meta!.status).toBe('running');
      expect(meta!.event_count).toBe(1);
    });

    it('should increment event count', async () => {
      await store.updateRunMeta(createRunStartedEvent());
      await store.updateRunMeta(createToolCalledEvent(2));
      await store.updateRunMeta(createToolCalledEvent(3));

      const meta = await store.loadRunMeta();
      expect(meta!.event_count).toBe(3);
    });

    it('should increment tool call count', async () => {
      await store.updateRunMeta(createRunStartedEvent());
      await store.updateRunMeta(createToolCalledEvent(2));
      await store.updateRunMeta(createToolCalledEvent(3));

      const meta = await store.loadRunMeta();
      expect(meta!.tool_call_count).toBe(2);
    });

    it('should update status on completion', async () => {
      await store.updateRunMeta(createRunStartedEvent());
      await store.updateRunMeta(createRunCompletedEvent());

      const meta = await store.loadRunMeta();
      expect(meta!.status).toBe('completed');
      expect(meta!.duration_ms).toBe(300000);
    });

    it('should update status on failure', async () => {
      await store.updateRunMeta(createRunStartedEvent());
      await store.updateRunMeta(createRunFailedEvent());

      const meta = await store.loadRunMeta();
      expect(meta!.status).toBe('failed');
    });

    it('should not change tool count on tool result', async () => {
      await store.updateRunMeta(createRunStartedEvent());
      await store.updateRunMeta(createToolCalledEvent(2));
      await store.updateRunMeta(createToolResultEvent(2));

      const meta = await store.loadRunMeta();
      expect(meta!.tool_call_count).toBe(1);
      expect(meta!.event_count).toBe(3);
    });
  });

  describe('loadRunMeta', () => {
    it('should load existing meta', async () => {
      await eventStore.append(createRunStartedEvent());
      await store.generateRunMeta();

      const meta = await store.loadRunMeta();
      expect(meta).not.toBeNull();
      expect(meta!.run_id).toBe(runId);
    });

    it('should return null for non-existent meta', async () => {
      const meta = await store.loadRunMeta();
      expect(meta).toBeNull();
    });

    it('should throw on corrupted file', async () => {
      const projectionsDir = store.getProjectionsDir();
      await fs.promises.mkdir(projectionsDir, { recursive: true });
      await fs.promises.writeFile(
        store.getRunMetaPath(),
        'invalid json',
        'utf-8'
      );

      await expect(store.loadRunMeta()).rejects.toThrow();
    });

    it('should throw on invalid schema', async () => {
      const projectionsDir = store.getProjectionsDir();
      await fs.promises.mkdir(projectionsDir, { recursive: true });
      await fs.promises.writeFile(
        store.getRunMetaPath(),
        JSON.stringify({ invalid: 'schema' }),
        'utf-8'
      );

      await expect(store.loadRunMeta()).rejects.toThrow(
        'Invalid run meta format'
      );
    });
  });

  describe('exists', () => {
    it('should return false when meta does not exist', async () => {
      const exists = await store.exists();
      expect(exists).toBe(false);
    });

    it('should return true after generating meta', async () => {
      await store.generateRunMeta();
      const exists = await store.exists();
      expect(exists).toBe(true);
    });
  });

  describe('delete', () => {
    it('should delete meta file', async () => {
      await store.generateRunMeta();
      expect(await store.exists()).toBe(true);

      await store.delete();
      expect(await store.exists()).toBe(false);
    });

    it('should not throw for non-existent file', async () => {
      await expect(store.delete()).resolves.not.toThrow();
    });
  });

  describe('integration with EventStore', () => {
    it('should generate consistent meta from events', async () => {
      // Simulate a complete run
      await eventStore.append(createRunStartedEvent());
      await eventStore.append(createToolCalledEvent(2));
      await eventStore.append(createToolResultEvent(2));
      await eventStore.append(createToolCalledEvent(3));
      await eventStore.append(createToolResultEvent(3));
      await eventStore.append(createToolCalledEvent(4));
      await eventStore.append(createToolResultEvent(4));
      await eventStore.append(createRunCompletedEvent());

      // Generate meta
      const generatedMeta = await store.generateRunMeta();

      // Verify
      expect(generatedMeta.event_count).toBe(8);
      expect(generatedMeta.tool_call_count).toBe(3);
      expect(generatedMeta.status).toBe('completed');
    });

    it('should match incremental and full generation', async () => {
      // Add events and update incrementally
      const events = [
        createRunStartedEvent(),
        createToolCalledEvent(2),
        createToolResultEvent(2),
        createRunCompletedEvent(),
      ];

      for (const event of events) {
        await eventStore.append(event);
        await store.updateRunMeta(event);
      }

      const incrementalMeta = await store.loadRunMeta();

      // Delete and regenerate from scratch
      await store.delete();
      const fullMeta = await store.generateRunMeta();

      // Should match
      expect(incrementalMeta!.event_count).toBe(fullMeta.event_count);
      expect(incrementalMeta!.tool_call_count).toBe(fullMeta.tool_call_count);
      expect(incrementalMeta!.status).toBe(fullMeta.status);
    });
  });
});

