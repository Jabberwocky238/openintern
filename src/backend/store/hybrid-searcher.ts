/**
 * HybridSearcher - Combines keyword and vector search scores
 *
 * Score = alpha * vectorScore + (1-alpha) * keywordScore
 * Both scores are normalized to [0, 1] before combining.
 */

import type { IEmbeddingProvider } from './embedding-provider.js';
import { VectorIndex } from './vector-index.js';
import { logger } from '../../utils/logger.js';

export interface HybridSearchResult {
  id: string;
  score: number;
  vectorScore: number;
  keywordScore: number;
}

export class HybridSearcher {
  private vectorIndex: VectorIndex;
  private embeddingProvider: IEmbeddingProvider;
  private alpha: number;

  constructor(
    vectorIndex: VectorIndex,
    embeddingProvider: IEmbeddingProvider,
    alpha: number = 0.6,
  ) {
    this.vectorIndex = vectorIndex;
    this.embeddingProvider = embeddingProvider;
    this.alpha = alpha;
  }

  /**
   * Index a document for vector search
   */
  async indexDocument(id: string, content: string): Promise<void> {
    const vector = await this.embeddingProvider.embed(content);
    this.vectorIndex.upsert(id, vector);
  }

  /**
   * Remove a document from the vector index
   */
  removeDocument(id: string): void {
    this.vectorIndex.remove(id);
  }

  /**
   * Persist the vector index to disk
   */
  async save(): Promise<void> {
    await this.vectorIndex.save();
  }

  /**
   * Load the vector index from disk
   */
  async load(): Promise<void> {
    await this.vectorIndex.load();
  }

  /**
   * Hybrid search: combine vector similarity with keyword scores.
   *
   * @param query - Search query text
   * @param keywordResults - Pre-computed keyword search results: Map<id, keywordScore>
   * @param topK - Number of results to return
   */
  async search(
    query: string,
    keywordResults: Map<string, number>,
    topK: number = 10,
  ): Promise<HybridSearchResult[]> {
    // Get vector search results
    let vectorResults: Array<{ id: string; score: number }> = [];
    if (this.vectorIndex.size > 0) {
      try {
        const queryVector = await this.embeddingProvider.embed(query);
        vectorResults = this.vectorIndex.search(queryVector, topK * 2);
      } catch (err) {
        logger.warn('Vector search failed, using keyword-only', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Normalize vector scores to [0, 1]
    const vectorMap = new Map<string, number>();
    if (vectorResults.length > 0) {
      const maxVec = vectorResults[0]!.score || 1;
      for (const r of vectorResults) {
        vectorMap.set(r.id, Math.max(0, r.score / maxVec));
      }
    }

    // Normalize keyword scores to [0, 1]
    const keywordMap = new Map<string, number>();
    let maxKw = 0;
    for (const score of keywordResults.values()) {
      if (score > maxKw) maxKw = score;
    }
    if (maxKw > 0) {
      for (const [id, score] of keywordResults) {
        keywordMap.set(id, score / maxKw);
      }
    }

    // Merge all candidate IDs
    const allIds = new Set([...vectorMap.keys(), ...keywordMap.keys()]);

    // Compute hybrid scores
    const results: HybridSearchResult[] = [];
    for (const id of allIds) {
      const vs = vectorMap.get(id) ?? 0;
      const ks = keywordMap.get(id) ?? 0;
      const combined = this.alpha * vs + (1 - this.alpha) * ks;
      results.push({
        id,
        score: combined,
        vectorScore: vs,
        keywordScore: ks,
      });
    }

    // Sort by combined score descending
    results.sort((a, b) => b.score - a.score);

    logger.debug('Hybrid search completed', {
      query: query.substring(0, 50),
      vectorCandidates: vectorMap.size,
      keywordCandidates: keywordMap.size,
      totalCandidates: allIds.size,
      returned: Math.min(results.length, topK),
    });

    return results.slice(0, topK);
  }
}

