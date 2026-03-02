/**
 * SSE Manager tests
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { SSEManager } from './sse.js';
import type { Response } from 'express';
import type { Event } from '@openintern/types/events.js';

interface MockResponse {
  setHeader: Mock;
  flushHeaders: Mock;
  write: Mock;
  end: Mock;
  _chunks: string[];
}

function createMockResponse(): Response & MockResponse {
  const chunks: string[] = [];
  const res: MockResponse = {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((data: string) => {
      chunks.push(data);
      return true;
    }),
    end: vi.fn(),
    _chunks: chunks,
  };
  return res as unknown as Response & MockResponse;
}

function createMockEvent(overrides: Partial<Event> = {}): Event {
  return {
    v: 1,
    ts: new Date().toISOString(),
    session_key: 's_test',
    run_id: 'run_test123456',
    agent_id: 'main',
    step_id: 'step_0001',
    span_id: 'sp_test123456',
    parent_span_id: null,
    type: 'run.started',
    payload: { input: 'test' },
    redaction: { contains_secrets: false },
    ...overrides,
  } as Event;
}

describe('SSEManager', () => {
  let manager: SSEManager;

  beforeEach(() => {
    manager = new SSEManager({ heartbeatIntervalMs: 100000 });
  });

  afterEach(() => {
    manager.shutdown();
  });

  describe('addClient', () => {
    it('should add a client and set SSE headers', () => {
      const res = createMockResponse();
      const clientId = manager.addClient('run_test', res);

      expect(clientId).toMatch(/^client_/);
      expect(res.setHeader.mock.calls).toContainEqual(['Content-Type', 'text/event-stream']);
      expect(res.setHeader.mock.calls).toContainEqual(['Cache-Control', 'no-cache']);
      expect(res.setHeader.mock.calls).toContainEqual(['Connection', 'keep-alive']);
      expect(res.flushHeaders).toHaveBeenCalled();
    });

    it('should send connected event to client', () => {
      const res = createMockResponse();
      manager.addClient('run_test', res);

      expect(res.write).toHaveBeenCalled();
      expect(res._chunks.some((c) => c.includes('event: connected'))).toBe(true);
    });

    it('should track client count', () => {
      const res1 = createMockResponse();
      const res2 = createMockResponse();

      manager.addClient('run_test', res1);
      manager.addClient('run_test', res2);

      expect(manager.getClientCount()).toBe(2);
      expect(manager.getRunClientCount('run_test')).toBe(2);
    });

    it('should throw when max clients reached', () => {
      const limitedManager = new SSEManager({ maxClientsPerRun: 2 });

      limitedManager.addClient('run_test', createMockResponse());
      limitedManager.addClient('run_test', createMockResponse());

      expect(() => {
        limitedManager.addClient('run_test', createMockResponse());
      }).toThrow('Maximum clients reached');

      limitedManager.shutdown();
    });
  });

  describe('removeClient', () => {
    it('should remove a client', () => {
      const res = createMockResponse();
      const clientId = manager.addClient('run_test', res);

      manager.removeClient(clientId);

      expect(manager.getClientCount()).toBe(0);
    });

    it('should handle removing non-existent client', () => {
      expect(() => manager.removeClient('client_nonexistent')).not.toThrow();
    });
  });

  describe('broadcastToRun', () => {
    it('should send event to all clients of a run', () => {
      const res1 = createMockResponse();
      const res2 = createMockResponse();

      manager.addClient('run_test', res1);
      manager.addClient('run_test', res2);

      const event = createMockEvent();
      manager.broadcastToRun('run_test', event);

      expect(res1._chunks.some((c) => c.includes('event: run.event'))).toBe(true);
      expect(res2._chunks.some((c) => c.includes('event: run.event'))).toBe(true);
    });

    it('should not send to clients of other runs', () => {
      const res1 = createMockResponse();
      const res2 = createMockResponse();

      manager.addClient('run_test1', res1);
      manager.addClient('run_test2', res2);

      const event = createMockEvent();
      manager.broadcastToRun('run_test1', event);

      expect(res1._chunks.some((c) => c.includes('event: run.event'))).toBe(true);
      // res2 should only have connected event
      expect(res2._chunks.filter((c) => c.includes('event: run.event'))).toHaveLength(0);
    });
  });

  describe('hasClients', () => {
    it('should return true when run has clients', () => {
      manager.addClient('run_test', createMockResponse());
      expect(manager.hasClients('run_test')).toBe(true);
    });

    it('should return false when run has no clients', () => {
      expect(manager.hasClients('run_test')).toBe(false);
    });
  });

  describe('heartbeat', () => {
    it('should start and stop heartbeat', () => {
      manager.startHeartbeat();
      manager.stopHeartbeat();
      // No error means success
    });
  });

  describe('shutdown', () => {
    it('should close all connections', () => {
      const res1 = createMockResponse();
      const res2 = createMockResponse();

      manager.addClient('run_test1', res1);
      manager.addClient('run_test2', res2);

      manager.shutdown();

      expect(res1.end).toHaveBeenCalled();
      expect(res2.end).toHaveBeenCalled();
      expect(manager.getClientCount()).toBe(0);
    });
  });
});

