/**
 * VectorIndex - In-memory vector index with JSON persistence
 *
 * Stores embedding vectors and supports cosine similarity search.
 * Persists to data/memory/shared/index/vector.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../utils/logger.js';

export interface VectorEntry {
  id: string;
  vector: number[];
}

interface VectorIndexData {
  version: 1;
  dimension: number;
  entries: VectorEntry[];
}

export class VectorIndex {
  private entries: Map<string, number[]> = new Map();
  private readonly persistPath: string;
  private readonly dimension: number;

  constructor(baseDir: string, dimension: number) {
    this.persistPath = path.join(baseDir, 'index', 'vector.json');
    this.dimension = dimension;
  }

  /**
   * Load index from disk
   */
  async load(): Promise<void> {
    try {
      const content = await fs.promises.readFile(this.persistPath, 'utf-8');
      const data = JSON.parse(content) as VectorIndexData;

      if (data.version !== 1 || data.dimension !== this.dimension) {
        logger.warn('Vector index version/dimension mismatch, rebuilding');
        this.entries.clear();
        return;
      }

      this.entries.clear();
      for (const entry of data.entries) {
        this.entries.set(entry.id, entry.vector);
      }

      logger.debug('Vector index loaded', { count: this.entries.size });
    } catch (err) {
      if (
        err instanceof Error &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return; // File doesn't exist yet
      }
      logger.warn('Failed to load vector index', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Save index to disk (atomic write)
   */
  async save(): Promise<void> {
    const dir = path.dirname(this.persistPath);
    await fs.promises.mkdir(dir, { recursive: true });

    const data: VectorIndexData = {
      version: 1,
      dimension: this.dimension,
      entries: Array.from(this.entries.entries()).map(([id, vector]) => ({
        id,
        vector,
      })),
    };

    const tempPath = this.persistPath + '.tmp';
    await fs.promises.writeFile(tempPath, JSON.stringify(data), 'utf-8');
    await fs.promises.rename(tempPath, this.persistPath);
  }

  /**
   * Add or update a vector entry
   */
  upsert(id: string, vector: number[]): void {
    this.entries.set(id, vector);
  }

  /**
   * Remove a vector entry
   */
  remove(id: string): void {
    this.entries.delete(id);
  }

  /**
   * Check if an entry exists
   */
  has(id: string): boolean {
    return this.entries.has(id);
  }

  /**
   * Get entry count
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Cosine similarity between two vectors (assumes normalized)
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      dot += a[i]! * b[i]!;
    }
    return dot;
  }

  /**
   * Search for the top-K most similar entries to a query vector
   */
  search(
    queryVector: number[],
    topK: number = 10,
  ): Array<{ id: string; score: number }> {
    const results: Array<{ id: string; score: number }> = [];

    for (const [id, vector] of this.entries) {
      const score = this.cosineSimilarity(queryVector, vector);
      results.push({ id, score });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }
}

