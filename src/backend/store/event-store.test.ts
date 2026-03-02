/**
 * EventStore tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventStore } from './event-store.js';
import type { Event, RunStartedEvent, ToolCalledEvent } from '../../types/events.js';

describe('EventStore', () => {
  let tempDir: string;
  let store: EventStore;

  const createTestEvent = (overrides: Partial<RunStartedEvent> = {}): RunStartedEvent => ({
    v: 1,
    ts: new Date().toISOString(),
    session_key: 's_test',
    run_id: 'run_abc123',
    agent_id: 'main',
    step_id: 'step_0001',
    span_id: 'sp_xyz789',
    parent_span_id: null,
    type: 'run.started',
    payload: {
      input: 'test input',
    },
    redaction: {
      contains_secrets: false,
    },
    ...overrides,
  });

  const createToolCalledEvent = (stepNum: number): ToolCalledEvent => ({
    v: 1,
    ts: new Date().toISOString(),
    session_key: 's_test',
    run_id: 'run_abc123',
    agent_id: 'main',
    step_id: `step_${String(stepNum).padStart(4, '0')}`,
    span_id: `sp_tool${stepNum}`,
    parent_span_id: 'sp_xyz789',
    type: 'tool.called',
    payload: {
      toolName: 'test_tool',
      args: { query: `test ${stepNum}` },
    },
    redaction: {
      contains_secrets: false,
    },
  });

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'event-store-test-'));
    store = new EventStore('s_test', 'run_abc123', tempDir);
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe('append', () => {
    it('should append a single event', async () => {
      const event = createTestEvent();
      await store.append(event);

      const events = await store.readAll();
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(event);
    });

    it('should create directory if not exists', async () => {
      const event = createTestEvent();
      await store.append(event);

      const exists = await store.exists();
      expect(exists).toBe(true);
    });

    it('should reject invalid events', async () => {
      const invalidEvent = {
        v: 1,
        ts: 'invalid-date',
        type: 'run.started',
      } as unknown as Event;

      await expect(store.append(invalidEvent)).rejects.toThrow('Invalid event format');
    });
  });

  describe('appendBatch', () => {
    it('should append multiple events atomically', async () => {
      const events = [
        createTestEvent(),
        createToolCalledEvent(1),
        createToolCalledEvent(2),
      ];

      await store.appendBatch(events);

      const saved = await store.readAll();
      expect(saved).toHaveLength(3);
    });

    it('should handle empty batch', async () => {
      await store.appendBatch([]);
      const events = await store.readAll();
      expect(events).toHaveLength(0);
    });

    it('should reject batch with invalid event', async () => {
      const events = [
        createTestEvent(),
        { invalid: true } as unknown as Event,
      ];

      await expect(store.appendBatch(events)).rejects.toThrow('Invalid event format');
    });
  });

  describe('readStream', () => {
    it('should stream all events', async () => {
      const events = [
        createTestEvent(),
        createToolCalledEvent(1),
        createToolCalledEvent(2),
      ];
      await store.appendBatch(events);

      const streamed: Event[] = [];
      for await (const event of store.readStream()) {
        streamed.push(event);
      }

      expect(streamed).toHaveLength(3);
    });

    it('should return empty for non-existent file', async () => {
      const events: Event[] = [];
      for await (const event of store.readStream()) {
        events.push(event);
      }
      expect(events).toHaveLength(0);
    });
  });

  describe('readAll', () => {
    it('should read all events', async () => {
      const event1 = createTestEvent();
      const event2 = createToolCalledEvent(1);

      await store.append(event1);
      await store.append(event2);

      const events = await store.readAll();
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual(event1);
      expect(events[1]).toEqual(event2);
    });

    it('should return empty array for empty file', async () => {
      const events = await store.readAll();
      expect(events).toHaveLength(0);
    });
  });

  describe('readFiltered', () => {
    it('should filter events by predicate', async () => {
      await store.append(createTestEvent());
      await store.append(createToolCalledEvent(1));
      await store.append(createToolCalledEvent(2));

      const toolEvents = await store.readFiltered(
        (e) => e.type === 'tool.called'
      );

      expect(toolEvents).toHaveLength(2);
      expect(toolEvents.every((e) => e.type === 'tool.called')).toBe(true);
    });

    it('should return empty if no matches', async () => {
      await store.append(createTestEvent());

      const events = await store.readFiltered(
        (e) => e.type === 'run.completed'
      );

      expect(events).toHaveLength(0);
    });
  });

  describe('readPage', () => {
    it('should read a page of events', async () => {
      for (let i = 0; i < 10; i++) {
        await store.append(createToolCalledEvent(i));
      }

      const page1 = await store.readPage(3, 0);
      expect(page1).toHaveLength(3);

      const page2 = await store.readPage(3, 3);
      expect(page2).toHaveLength(3);

      const page4 = await store.readPage(3, 9);
      expect(page4).toHaveLength(1);
    });

    it('should handle offset beyond total', async () => {
      await store.append(createTestEvent());

      const page = await store.readPage(10, 100);
      expect(page).toHaveLength(0);
    });
  });

  describe('buildIndex', () => {
    it('should build index file', async () => {
      for (let i = 0; i < 10; i++) {
        await store.append(createToolCalledEvent(i));
      }

      await store.buildIndex(3);

      const indexPath = store.getIndexPath();
      const indexContent = await fs.promises.readFile(indexPath, 'utf-8');
      const lines = indexContent.trim().split('\n').filter(Boolean);

      // Should have entries at 0, 3, 6, 9
      expect(lines.length).toBe(4);

      const firstEntry = JSON.parse(lines[0]!) as { line: number; offset: number };
      expect(firstEntry.line).toBe(0);
      expect(firstEntry.offset).toBe(0);
    });

    it('should handle empty events file', async () => {
      await store.buildIndex(10);

      const indexPath = store.getIndexPath();
      const indexContent = await fs.promises.readFile(indexPath, 'utf-8');
      expect(indexContent).toBe('');
    });
  });

  describe('count', () => {
    it('should return event count', async () => {
      await store.append(createTestEvent());
      await store.append(createToolCalledEvent(1));
      await store.append(createToolCalledEvent(2));

      const count = await store.count();
      expect(count).toBe(3);
    });

    it('should return 0 for empty store', async () => {
      const count = await store.count();
      expect(count).toBe(0);
    });
  });

  describe('exists', () => {
    it('should return false for non-existent file', async () => {
      const exists = await store.exists();
      expect(exists).toBe(false);
    });

    it('should return true after append', async () => {
      await store.append(createTestEvent());
      const exists = await store.exists();
      expect(exists).toBe(true);
    });
  });

  describe('corrupted data handling', () => {
    it('should skip corrupted lines gracefully', async () => {
      // Write valid event
      await store.append(createTestEvent());

      // Manually append corrupted line
      const eventsPath = store.getEventsPath();
      await fs.promises.appendFile(eventsPath, 'invalid json\n', 'utf-8');

      // Write another valid event
      await store.append(createToolCalledEvent(1));

      // Should read 2 valid events, skipping corrupted
      const events = await store.readAll();
      expect(events).toHaveLength(2);
    });
  });

  describe('concurrent writes', () => {
    it('should handle concurrent appends safely', async () => {
      const events = Array.from({ length: 20 }, (_, i) =>
        createToolCalledEvent(i)
      );

      // Append all events concurrently
      await Promise.all(events.map((e) => store.append(e)));

      const saved = await store.readAll();
      expect(saved).toHaveLength(20);
    });
  });
});

