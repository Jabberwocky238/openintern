/**
 * ContextManager tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { ContextManager } from './context-manager.js';

describe('ContextManager', () => {
  let contextManager: ContextManager;
  const testDir = '/tmp/test-context-manager-' + Date.now();
  const sessionKey = 's_test';
  const runId = 'run_test123';

  beforeEach(async () => {
    await fs.promises.mkdir(testDir, { recursive: true });
    contextManager = new ContextManager(runId, sessionKey, {}, testDir);
  });

  afterEach(async () => {
    await fs.promises.rm(testDir, { recursive: true, force: true });
  });

  describe('Message management', () => {
    it('should add messages', () => {
      contextManager.addMessage('user', 'Hello');
      contextManager.addMessage('assistant', 'Hi there');

      const messages = contextManager.getMessages();
      expect(messages).toHaveLength(2);
      expect(messages[0]?.role).toBe('user');
      expect(messages[1]?.role).toBe('assistant');
    });

    it('should clear messages', () => {
      contextManager.addMessage('user', 'Hello');
      contextManager.clearMessages();

      expect(contextManager.getMessages()).toHaveLength(0);
    });

    it('should add tool message with toolCallId', () => {
      contextManager.addMessage('tool', 'Result', 'tc_123');

      const messages = contextManager.getMessages();
      expect(messages[0]?.toolCallId).toBe('tc_123');
    });
  });

  describe('Step management', () => {
    it('should track step number', () => {
      expect(contextManager.getCurrentStepNumber()).toBe(0);

      contextManager.incrementStep();
      expect(contextManager.getCurrentStepNumber()).toBe(1);

      contextManager.incrementStep();
      expect(contextManager.getCurrentStepNumber()).toBe(2);
    });

    it('should set step number', () => {
      contextManager.setStepNumber(5);
      expect(contextManager.getCurrentStepNumber()).toBe(5);
    });
  });

  describe('Context building', () => {
    it('should build context with messages', async () => {
      contextManager.addMessage('user', 'Hello');
      contextManager.addMessage('assistant', 'Hi');

      const context = await contextManager.buildContext();

      expect(context.systemPrompt).toBeDefined();
      expect(context.messages).toHaveLength(2);
      expect(context.totalTokens).toBeGreaterThan(0);
    });

    it('should include system prompt', async () => {
      const context = await contextManager.buildContext();
      expect(context.systemPrompt).toContain('AI assistant');
    });
  });
});
