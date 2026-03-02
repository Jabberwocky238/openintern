/**
 * IEmbeddingProvider - Interface for embedding generation
 *
 * Two implementations:
 * - HashEmbeddingProvider: zero-dependency, deterministic hash-based
 * - ApiEmbeddingProvider: calls external embedding API
 */

import type { EmbeddingConfig } from '@openintern/types/embedding.js';
import { logger } from '@openintern/utils';

export interface IEmbeddingProvider {
  readonly dimension: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

/**
 * Simple hash function for strings (FNV-1a variant)
 */
function hashCode(str: string, seed: number): number {
  let h = seed ^ 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Tokenize text for hash embedding (CJK-aware)
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();

  // Extract CJK characters individually (each is a token)
  const cjkMatches = lower.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g);
  if (cjkMatches) {
    tokens.push(...cjkMatches);
  }

  // Extract Latin words (2+ chars)
  const latinWords = lower.match(/[a-z0-9]{2,}/g);
  if (latinWords) {
    tokens.push(...latinWords);
  }

  // Generate bigrams for CJK
  if (cjkMatches && cjkMatches.length >= 2) {
    for (let i = 0; i < cjkMatches.length - 1; i++) {
      tokens.push(cjkMatches[i]! + cjkMatches[i + 1]!);
    }
  }

  return tokens;
}

/**
 * Normalize a vector to unit length
 */
function normalize(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

/**
 * HashEmbeddingProvider - Zero-dependency, deterministic hash-based embeddings.
 * Uses random hyperplane hashing (SimHash variant) for locality-sensitive hashing.
 */
export class HashEmbeddingProvider implements IEmbeddingProvider {
  readonly dimension: number;

  constructor(dimension: number = 256) {
    this.dimension = dimension;
  }

  embed(text: string): Promise<number[]> {
    const tokens = tokenize(text);
    const vec = new Array<number>(this.dimension).fill(0);

    for (const token of tokens) {
      for (let d = 0; d < this.dimension; d++) {
        const h = hashCode(token, d * 31 + 7);
        vec[d]! += (h & 1) === 0 ? 1 : -1;
      }
    }

    return Promise.resolve(normalize(vec));
  }

  embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

/**
 * ApiEmbeddingProvider - Calls an external embedding API (OpenAI-compatible).
 */
export class ApiEmbeddingProvider implements IEmbeddingProvider {
  readonly dimension: number;
  private apiUrl: string;
  private apiModel: string;
  private apiKey: string;

  constructor(config: {
    dimension: number;
    apiUrl: string;
    apiModel: string;
    apiKey: string;
  }) {
    this.dimension = config.dimension;
    this.apiUrl = config.apiUrl;
    this.apiModel = config.apiModel;
    this.apiKey = config.apiKey;
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0]!;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    try {
      const resp = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.apiModel,
          input: texts,
        }),
      });

      if (!resp.ok) {
        throw new Error(`Embedding API error: ${resp.status}`);
      }

      const json = (await resp.json()) as {
        data: Array<{ embedding: number[] }>;
      };

      return json.data.map((d) => normalize(d.embedding));
    } catch (err) {
      logger.error('Embedding API call failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}

/**
 * Factory: create an embedding provider from config
 */
export function createEmbeddingProvider(
  config: EmbeddingConfig,
): IEmbeddingProvider {
  if (config.provider === 'api') {
    const apiUrl = config.apiUrl ?? 'https://api.openai.com/v1/embeddings';
    const apiModel = config.apiModel ?? 'text-embedding-3-small';
    const apiKey = process.env['EMBEDDING_API_KEY'] ?? '';
    return new ApiEmbeddingProvider({
      dimension: config.dimension,
      apiUrl,
      apiModel,
      apiKey,
    });
  }

  return new HashEmbeddingProvider(config.dimension);
}

