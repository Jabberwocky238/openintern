/**
 * MemoryStore - Store memory items with keyword search (MVP)
 *
 * Storage:
 * - data/memory/shared/items/<memory_id>.json - Individual memory items
 * - data/memory/shared/index/keyword.json - Inverted index for keyword search
 */

import fs from 'node:fs';
import path from 'node:path';
import { MemoryItemSchema, type MemoryItem } from '../../types/memory.js';
import { MemoryStoreError } from '../../utils/errors.js';
import type { HybridSearcher } from './hybrid-searcher.js';

/**
 * Keyword index structure: { keyword: [memory_id1, memory_id2, ...] }
 */
export type KeywordIndex = Record<string, string[]>;

/**
 * MemoryStore class for managing memory items with keyword search
 */
export class MemoryStore {
  private readonly itemsDir: string;
  private readonly indexDir: string;
  private readonly keywordIndexPath: string;
  private hybridSearcher: HybridSearcher | null = null;

  constructor(private readonly baseDir: string = 'data/memory/shared') {
    this.itemsDir = path.join(baseDir, 'items');
    this.indexDir = path.join(baseDir, 'index');
    this.keywordIndexPath = path.join(this.indexDir, 'keyword.json');
  }

  /**
   * Set a hybrid searcher for combined keyword+vector search
   */
  setHybridSearcher(searcher: HybridSearcher): void {
    this.hybridSearcher = searcher;
  }

  /**
   * Get the items directory path
   */
  getItemsDir(): string {
    return this.itemsDir;
  }

  /**
   * Get the keyword index file path
   */
  getKeywordIndexPath(): string {
    return this.keywordIndexPath;
  }

  /**
   * Ensure the items directory exists
   */
  private async ensureItemsDir(): Promise<void> {
    await fs.promises.mkdir(this.itemsDir, { recursive: true });
  }

  /**
   * Ensure the index directory exists
   */
  private async ensureIndexDir(): Promise<void> {
    await fs.promises.mkdir(this.indexDir, { recursive: true });
  }

  /**
   * Validate a memory item using Zod schema
   */
  private validateItem(item: MemoryItem): void {
    const result = MemoryItemSchema.safeParse(item);
    if (!result.success) {
      throw new MemoryStoreError('Invalid memory item format', {
        errors: result.error.errors,
        itemId: item.id,
      });
    }
  }

  /**
   * Get the file path for a memory item
   */
  private getItemPath(id: string): string {
    return path.join(this.itemsDir, `${id}.json`);
  }

  /**
   * Write a memory item to storage
   */
  async write(item: MemoryItem): Promise<void> {
    this.validateItem(item);

    try {
      await this.ensureItemsDir();
      const itemPath = this.getItemPath(item.id);
      const content = JSON.stringify(item, null, 2);
      await fs.promises.writeFile(itemPath, content, { encoding: 'utf-8' });

      // Update keyword index
      await this.updateKeywordIndex(item);

      // Update vector index if hybrid searcher is available
      if (this.hybridSearcher) {
        try {
          await this.hybridSearcher.indexDocument(item.id, item.content);
          await this.hybridSearcher.save();
        } catch {
          // Non-fatal: vector indexing failure shouldn't block writes
        }
      }
    } catch (error) {
      if (error instanceof MemoryStoreError) {
        throw error;
      }
      throw new MemoryStoreError('Failed to write memory item', {
        itemId: item.id,
        originalError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get a memory item by ID
   * @returns MemoryItem or null if not found
   */
  async get(id: string): Promise<MemoryItem | null> {
    const itemPath = this.getItemPath(id);

    try {
      const content = await fs.promises.readFile(itemPath, 'utf-8');
      const parsed = JSON.parse(content) as unknown;
      const result = MemoryItemSchema.safeParse(parsed);

      if (!result.success) {
        throw new MemoryStoreError('Invalid memory item format in file', {
          filePath: itemPath,
          errors: result.error.errors,
        });
      }

      return result.data;
    } catch (error) {
      if (error instanceof MemoryStoreError) {
        throw error;
      }
      // File not found - return null
      if (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return null;
      }
      throw new MemoryStoreError('Failed to get memory item', {
        itemId: id,
        originalError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Search memory items by keyword (simple substring match for MVP)
   * @param query - Search query string
   * @param topK - Maximum number of results to return
   * @returns Array of matching MemoryItems
   */
  async search(query: string, topK: number = 10): Promise<MemoryItem[]> {
    if (!query.trim()) {
      return [];
    }

    try {
      // Load keyword index
      const index = await this.loadKeywordIndex();
      const queryLower = query.toLowerCase();

      // Split query into individual words for matching
      const queryWords = queryLower
        .split(/\s+/)
        .map((w) => w.replace(/[^a-z0-9\u4e00-\u9fff]/g, ''))
        .filter((w) => w.length >= 2);

      // Find matching memory IDs from index
      const matchScores = new Map<string, number>();

      // Search through index keywords for word-level matches
      for (const [keyword, ids] of Object.entries(index)) {
        for (const word of queryWords) {
          if (keyword.includes(word) || word.includes(keyword)) {
            for (const id of ids) {
              matchScores.set(id, (matchScores.get(id) ?? 0) + 1);
            }
          }
        }
      }

      // Fallback: direct content search with word-level matching
      const allItemIds = await this.listAllItemIds();
      for (const id of allItemIds) {
        if (matchScores.size >= topK * 2) {
          break;
        }
        if (!matchScores.has(id)) {
          const item = await this.get(id);
          if (item) {
            const contentLower = item.content.toLowerCase();
            for (const word of queryWords) {
              if (contentLower.includes(word)) {
                matchScores.set(id, (matchScores.get(id) ?? 0) + 1);
              }
            }
          }
        }
      }

      // Sort by score (descending) and return top K
      const sortedIds = [...matchScores.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, topK)
        .map(([id]) => id);

      // Load and return matching items
      const results: MemoryItem[] = [];
      for (const id of sortedIds) {
        if (results.length >= topK) {
          break;
        }
        const item = await this.get(id);
        if (item) {
          results.push(item);
        }
      }

      return results;
    } catch (error) {
      if (error instanceof MemoryStoreError) {
        throw error;
      }
      throw new MemoryStoreError('Failed to search memory items', {
        query,
        originalError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Hybrid search combining keyword and vector scores.
   * Falls back to keyword-only search if no hybrid searcher is configured.
   */
  async searchHybrid(
    query: string,
    topK: number = 10,
  ): Promise<Array<{ item: MemoryItem; score: number }>> {
    if (!this.hybridSearcher) {
      const items = await this.search(query, topK);
      return items.map((item, i) => ({
        item,
        score: 1 - i * 0.1,
      }));
    }

    // Build keyword scores from existing search
    const keywordScores = await this.buildKeywordScores(query);

    const hybridResults = await this.hybridSearcher.search(
      query,
      keywordScores,
      topK,
    );

    const results: Array<{ item: MemoryItem; score: number }> = [];
    for (const hr of hybridResults) {
      const item = await this.get(hr.id);
      if (item) {
        results.push({ item, score: hr.score });
      }
    }

    return results;
  }

  /**
   * Build keyword match scores for hybrid search
   */
  private async buildKeywordScores(query: string): Promise<Map<string, number>> {
    const scores = new Map<string, number>();
    const queryLower = query.toLowerCase();

    const queryWords = queryLower
      .split(/\s+/)
      .map((w) => w.replace(/[^a-z0-9\u4e00-\u9fff]/g, ''))
      .filter((w) => w.length >= 1);

    const index = await this.loadKeywordIndex();

    for (const [keyword, ids] of Object.entries(index)) {
      for (const word of queryWords) {
        if (keyword.includes(word) || word.includes(keyword)) {
          for (const id of ids) {
            scores.set(id, (scores.get(id) ?? 0) + 1);
          }
        }
      }
    }

    return scores;
  }

  /**
   * Update the keyword index with a memory item (private method)
   */
  private async updateKeywordIndex(item: MemoryItem): Promise<void> {
    try {
      await this.ensureIndexDir();

      // Load existing index
      const index = await this.loadKeywordIndex();

      // Extract keywords from item
      const keywords = this.extractKeywords(item);

      // Remove old entries for this item (in case of update)
      for (const ids of Object.values(index)) {
        const idx = ids.indexOf(item.id);
        if (idx !== -1) {
          ids.splice(idx, 1);
        }
      }

      // Add new entries
      for (const keyword of keywords) {
        if (!index[keyword]) {
          index[keyword] = [];
        }
        if (!index[keyword].includes(item.id)) {
          index[keyword].push(item.id);
        }
      }

      // Clean up empty keyword entries
      for (const [keyword, ids] of Object.entries(index)) {
        if (ids.length === 0) {
          delete index[keyword];
        }
      }

      // Save updated index (atomic write using temp file + rename)
      const content = JSON.stringify(index, null, 2);
      const tempPath = this.keywordIndexPath + '.tmp';
      await fs.promises.writeFile(tempPath, content, {
        encoding: 'utf-8',
      });
      await fs.promises.rename(tempPath, this.keywordIndexPath);
    } catch (error) {
      throw new MemoryStoreError('Failed to update keyword index', {
        itemId: item.id,
        originalError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Load the keyword index from file
   */
  private async loadKeywordIndex(): Promise<KeywordIndex> {
    try {
      const content = await fs.promises.readFile(
        this.keywordIndexPath,
        'utf-8'
      );
      return JSON.parse(content) as KeywordIndex;
    } catch (error) {
      // File not found - return empty index
      if (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return {};
      }
      throw error;
    }
  }

  /**
   * Extract keywords from a memory item
   * Uses item.keywords if provided, otherwise extracts from content
   */
  private extractKeywords(item: MemoryItem): string[] {
    const keywords = new Set<string>();

    // Add explicit keywords (lowercase)
    if (item.keywords && item.keywords.length > 0) {
      for (const kw of item.keywords) {
        keywords.add(kw.toLowerCase());
      }
    }

    // Extract Latin words from content (2+ chars)
    const latinWords = item.content
      .toLowerCase()
      .match(/[a-z0-9]{2,}/g);
    if (latinWords) {
      for (const w of latinWords) {
        if (w.length >= 3) keywords.add(w);
      }
    }

    // Extract CJK characters and bigrams
    const cjkChars = item.content.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g);
    if (cjkChars) {
      for (const ch of cjkChars) {
        keywords.add(ch);
      }
      // CJK bigrams for better matching
      for (let i = 0; i < cjkChars.length - 1; i++) {
        keywords.add(cjkChars[i]! + cjkChars[i + 1]!);
      }
    }

    return Array.from(keywords);
  }

  /**
   * List all memory item IDs
   */
  private async listAllItemIds(): Promise<string[]> {
    try {
      const files = await fs.promises.readdir(this.itemsDir);
      return files
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace('.json', ''));
    } catch (error) {
      // Directory not found - return empty
      if (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return [];
      }
      throw error;
    }
  }

  /**
   * Delete a memory item by ID
   */
  async delete(id: string): Promise<void> {
    const itemPath = this.getItemPath(id);

    try {
      // Remove from keyword index first
      const index = await this.loadKeywordIndex();
      let indexChanged = false;

      for (const ids of Object.values(index)) {
        const idx = ids.indexOf(id);
        if (idx !== -1) {
          ids.splice(idx, 1);
          indexChanged = true;
        }
      }

      if (indexChanged) {
        // Clean up empty keyword entries
        for (const [keyword, ids] of Object.entries(index)) {
          if (ids.length === 0) {
            delete index[keyword];
          }
        }

        await this.ensureIndexDir();
        const content = JSON.stringify(index, null, 2);
        await fs.promises.writeFile(this.keywordIndexPath, content, {
          encoding: 'utf-8',
        });
      }

      // Delete the item file
      await fs.promises.unlink(itemPath);
    } catch (error) {
      // Ignore if file doesn't exist
      if (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return;
      }
      throw new MemoryStoreError('Failed to delete memory item', {
        itemId: id,
        originalError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Check if a memory item exists
   */
  async exists(id: string): Promise<boolean> {
    const itemPath = this.getItemPath(id);
    try {
      await fs.promises.access(itemPath, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all memory items
   */
  async listAll(): Promise<MemoryItem[]> {
    const ids = await this.listAllItemIds();
    const items: MemoryItem[] = [];

    for (const id of ids) {
      const item = await this.get(id);
      if (item) {
        items.push(item);
      }
    }

    return items;
  }
}

