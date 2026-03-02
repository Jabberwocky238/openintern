/**
 * ToolRouter tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { ToolRouter } from './tool-router.js';

describe('ToolRouter', () => {
  let router: ToolRouter;
  const testDir = '/tmp/test-tool-router-' + Date.now();

  beforeEach(async () => {
    await fs.promises.mkdir(testDir, { recursive: true });
    router = new ToolRouter({ memoryBaseDir: `${testDir}/memory` });
  });

  afterEach(async () => {
    await fs.promises.rm(testDir, { recursive: true, force: true });
  });

  describe('Tool registration', () => {
    it('should have built-in memory tools', () => {
      const tools = router.listTools();
      const toolNames = tools.map(t => t.name);

      expect(toolNames).toContain('memory_write');
      expect(toolNames).toContain('memory_search');
      expect(toolNames).toContain('memory_get');
    });

    it('should register custom tool', () => {
      router.registerTool({
        name: 'custom_tool',
        description: 'A custom tool',
        parameters: { type: 'object' },
        execute: () => Promise.resolve({ result: 'ok' }),
      });

      expect(router.hasTool('custom_tool')).toBe(true);
      expect(router.getToolCount()).toBe(8); // 3 memory + 4 file + 1 custom
    });

    it('should unregister tool', () => {
      router.registerTool({
        name: 'temp_tool',
        description: 'Temporary',
        parameters: {},
        execute: () => Promise.resolve({}),
      });

      expect(router.hasTool('temp_tool')).toBe(true);
      router.unregisterTool('temp_tool');
      expect(router.hasTool('temp_tool')).toBe(false);
    });
  });

  describe('Tool execution', () => {
    it('should call memory_write tool', async () => {
      const result = await router.callTool('memory_write', {
        content: 'Test content',
        tags: ['test'],
      });

      expect(result.success).toBe(true);
      expect(result.result).toHaveProperty('id');
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should call memory_search tool', async () => {
      // First write something
      await router.callTool('memory_write', {
        content: 'Searchable content',
      });

      const result = await router.callTool('memory_search', {
        query: 'searchable',
        topK: 5,
      });

      expect(result.success).toBe(true);
      expect(result.result).toHaveProperty('results');
    });

    it('should return error for non-existent tool', async () => {
      const result = await router.callTool('non_existent', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should handle tool execution errors', async () => {
      router.registerTool({
        name: 'error_tool',
        description: 'Always fails',
        parameters: {},
        execute: () => Promise.reject(new Error('Intentional error')),
      });

      const result = await router.callTool('error_tool', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Intentional error');
    });
  });
});

