/**
 * MemoryStore tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MemoryStore } from './memory-store.js';
import type { MemoryItem } from '@openintern/types/memory.js';

describe('MemoryStore', () => {
  let tempDir: string;
  let store: MemoryStore;

  const createTestItem = (overrides: Partial<MemoryItem> = {}): MemoryItem => ({
    id: `mem_${Math.random().toString(36).substring(2, 10)}`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    content: 'This is a test memory item about TypeScript programming.',
    keywords: ['typescript', 'programming', 'test'],
    ...overrides,
  });

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'memory-store-test-')
    );
    store = new MemoryStore(tempDir);
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe('write', () => {
    it('should write a memory item', async () => {
      const item = createTestItem({ id: 'mem_abc123' });
      await store.write(item);

      const saved = await store.get('mem_abc123');
      expect(saved).toEqual(item);
    });

    it('should create directory if not exists', async () => {
      const item = createTestItem();
      await store.write(item);

      const exists = await store.exists(item.id);
      expect(exists).toBe(true);
    });

    it('should reject invalid items', async () => {
      const invalidItem = {
        id: 'invalid-id-format',
        content: 'test',
      } as unknown as MemoryItem;

      await expect(store.write(invalidItem)).rejects.toThrow(
        'Invalid memory item format'
      );
    });

    it('should update keyword index on write', async () => {
      const item = createTestItem({
        id: 'mem_indexed1',
        keywords: ['react', 'hooks'],
      });
      await store.write(item);

      const indexPath = store.getKeywordIndexPath();
      const indexContent = await fs.promises.readFile(indexPath, 'utf-8');
      const index = JSON.parse(indexContent) as Record<string, string[]>;

      expect(index['react']).toContain('mem_indexed1');
      expect(index['hooks']).toContain('mem_indexed1');
    });
  });

  describe('get', () => {
    it('should get a memory item by ID', async () => {
      const item = createTestItem({ id: 'mem_gettest' });
      await store.write(item);

      const retrieved = await store.get('mem_gettest');
      expect(retrieved).toEqual(item);
    });

    it('should return null for non-existent item', async () => {
      const result = await store.get('mem_nonexistent');
      expect(result).toBeNull();
    });

    it('should throw on corrupted file', async () => {
      // Create corrupted file
      const itemsDir = store.getItemsDir();
      await fs.promises.mkdir(itemsDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(itemsDir, 'mem_corrupted.json'),
        'invalid json',
        'utf-8'
      );

      await expect(store.get('mem_corrupted')).rejects.toThrow();
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      // Create test items
      await store.write(
        createTestItem({
          id: 'mem_search1',
          content: 'Learning TypeScript for web development',
          keywords: ['typescript', 'web'],
        })
      );
      await store.write(
        createTestItem({
          id: 'mem_search2',
          content: 'React hooks are powerful for state management',
          keywords: ['react', 'hooks', 'state'],
        })
      );
      await store.write(
        createTestItem({
          id: 'mem_search3',
          content: 'Node.js backend development with Express',
          keywords: ['nodejs', 'backend', 'express'],
        })
      );
    });

    it('should find items by keyword', async () => {
      const results = await store.search('typescript', 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.id === 'mem_search1')).toBe(true);
    });

    it('should find items by content substring', async () => {
      const results = await store.search('hooks', 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.id === 'mem_search2')).toBe(true);
    });

    it('should respect topK limit', async () => {
      const results = await store.search('development', 1);
      expect(results.length).toBeLessThanOrEqual(1);
    });

    it('should return empty for no matches', async () => {
      const results = await store.search('nonexistentkeyword123', 10);
      expect(results).toHaveLength(0);
    });

    it('should return empty for empty query', async () => {
      const results = await store.search('', 10);
      expect(results).toHaveLength(0);
    });

    it('should be case insensitive', async () => {
      const results = await store.search('TYPESCRIPT', 10);
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('delete', () => {
    it('should delete a memory item', async () => {
      const item = createTestItem({ id: 'mem_todelete' });
      await store.write(item);

      await store.delete('mem_todelete');

      const exists = await store.exists('mem_todelete');
      expect(exists).toBe(false);
    });

    it('should remove from keyword index on delete', async () => {
      const item = createTestItem({
        id: 'mem_indexdel',
        keywords: ['uniquekeyword'],
      });
      await store.write(item);

      // Verify in index
      let indexContent = await fs.promises.readFile(
        store.getKeywordIndexPath(),
        'utf-8'
      );
      let index = JSON.parse(indexContent) as Record<string, string[]>;
      expect(index['uniquekeyword']).toContain('mem_indexdel');

      // Delete item
      await store.delete('mem_indexdel');

      // Verify removed from index
      indexContent = await fs.promises.readFile(
        store.getKeywordIndexPath(),
        'utf-8'
      );
      index = JSON.parse(indexContent) as Record<string, string[]>;
      expect(index['uniquekeyword']).toBeUndefined();
    });

    it('should not throw for non-existent item', async () => {
      await expect(store.delete('mem_nonexistent')).resolves.not.toThrow();
    });
  });

  describe('exists', () => {
    it('should return true for existing item', async () => {
      const item = createTestItem({ id: 'mem_exists' });
      await store.write(item);

      const exists = await store.exists('mem_exists');
      expect(exists).toBe(true);
    });

    it('should return false for non-existent item', async () => {
      const exists = await store.exists('mem_notexists');
      expect(exists).toBe(false);
    });
  });

  describe('listAll', () => {
    it('should list all memory items', async () => {
      await store.write(createTestItem({ id: 'mem_list1' }));
      await store.write(createTestItem({ id: 'mem_list2' }));
      await store.write(createTestItem({ id: 'mem_list3' }));

      const items = await store.listAll();
      expect(items).toHaveLength(3);
    });

    it('should return empty array when no items', async () => {
      const items = await store.listAll();
      expect(items).toHaveLength(0);
    });
  });

  describe('keyword extraction', () => {
    it('should extract keywords from content', async () => {
      const item = createTestItem({
        id: 'mem_extract',
        content: 'JavaScript and Python are popular languages',
        keywords: [],
      });
      await store.write(item);

      // Search should find by content words
      const results = await store.search('javascript', 10);
      expect(results.some((r) => r.id === 'mem_extract')).toBe(true);
    });

    it('should handle items with no explicit keywords', async () => {
      const item: MemoryItem = {
        id: 'mem_nokw',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        content: 'Database optimization techniques',
        keywords: [],
      };
      await store.write(item);

      const results = await store.search('database', 10);
      expect(results.some((r) => r.id === 'mem_nokw')).toBe(true);
    });
  });

  describe('update existing item', () => {
    it('should update item and refresh index', async () => {
      // Write initial item
      const item = createTestItem({
        id: 'mem_update',
        keywords: ['oldkeyword'],
      });
      await store.write(item);

      // Update with new keywords
      const updatedItem = {
        ...item,
        keywords: ['newkeyword'],
        updated_at: new Date().toISOString(),
      };
      await store.write(updatedItem);

      // Old keyword should be removed
      const oldResults = await store.search('oldkeyword', 10);
      expect(oldResults.some((r) => r.id === 'mem_update')).toBe(false);

      // New keyword should be present
      const newResults = await store.search('newkeyword', 10);
      expect(newResults.some((r) => r.id === 'mem_update')).toBe(true);
    });
  });
});

