import type { IPostgresClient, IPostgresPool } from '@openintern/repository';
import type {
  BlackboardWriteRequest,
  MemoryGetResponse,
  MemoryScope,
  MemorySearchResult,
  MemoryType,
  MemoryWriteRequest,
  TieredSearchInput,
} from '../../types/memory.js';
import type { IEmbeddingProvider } from '../store/embedding-provider.js';
import { splitIntoChunks } from './text-chunker.js';
import {
  appendScopePredicate,
  toScopeContext,
  toMemoryScopeContext,
  type MemoryScopeContext,
} from './scope.js';

interface MemoryRow {
  id: string;
  type: MemoryType;
  text: string;
  metadata: Record<string, unknown>;
  created_at: string | Date;
  updated_at: string | Date;
}

interface SearchRow {
  id: string;
  type: MemoryType;
  snippet: string;
  score: number;
}

interface MemorySearchInput {
  query: string;
  scope: MemoryScope;
  top_k: number;
  filters?: Record<string, unknown>;
}

interface FeishuChunkInput {
  text: string;
  snippet?: string;
  metadata?: Record<string, unknown>;
}

interface ReplaceArchivalDocumentInput {
  scope: MemoryScope;
  source: {
    source_type: string;
    source_key: string;
  };
  text: string;
  metadata?: Record<string, unknown>;
  chunks: FeishuChunkInput[];
  importance?: number;
  project_shared?: boolean;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.map((value) => Number(value).toFixed(8)).join(',')}]`;
}

function normalizeScores(rows: SearchRow[]): Map<string, number> {
  const map = new Map<string, number>();
  const max = rows.reduce((acc, row) => Math.max(acc, row.score), 0);
  if (max <= 0) {
    return map;
  }
  for (const row of rows) {
    map.set(row.id, row.score / max);
  }
  return map;
}

function extractTypeFilter(filters: Record<string, unknown> | undefined): MemoryType[] {
  if (!filters) {
    return [];
  }
  const typeValue = filters['type'];
  if (typeof typeValue === 'string' && ['core', 'episodic', 'archival'].includes(typeValue)) {
    return [typeValue as MemoryType];
  }
  const listValue = filters['types'];
  if (Array.isArray(listValue)) {
    return listValue.filter(
      (value): value is MemoryType =>
        typeof value === 'string' && ['core', 'episodic', 'archival'].includes(value)
    );
  }
  return [];
}

const PROJECT_SHARED_USER_ID = 'user_project_shared';

export class MemoryService {
  constructor(
    private readonly pool: IPostgresPool,
    private readonly embeddingProvider: IEmbeddingProvider
  ) {}

  async memory_write(input: MemoryWriteRequest): Promise<{ id: string }> {
    const scope = toMemoryScopeContext(input.scope);
    const chunks = splitIntoChunks(input.text);
    const chunkTexts = chunks.map((chunk) => chunk.text);
    const embeddings = chunkTexts.length > 0
      ? await this.embeddingProvider.embedBatch(chunkTexts)
      : [];

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const memoryResult = await client.query<{ id: string }>(
        `INSERT INTO memories (
          org_id,
          user_id,
          project_id,
          group_id,
          agent_instance_id,
          type,
          text,
          metadata,
          importance
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
        RETURNING id::text AS id`,
        [
          scope.orgId,
          scope.userId,
          scope.projectId,
          scope.groupId,
          scope.agentInstanceId,
          input.type,
          input.text,
          JSON.stringify(input.metadata ?? {}),
          input.importance ?? 0.5,
        ]
      );
      const memoryId = memoryResult.rows[0]?.id;
      if (!memoryId) {
        throw new Error('Failed to insert memory item');
      }

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const embedding = embeddings[i];
        if (!chunk || !embedding) {
          continue;
        }
        await this.insertChunk(client, {
          memoryId,
          orgId: scope.orgId,
          userId: scope.userId,
          projectId: scope.projectId,
          groupId: scope.groupId,
          agentInstanceId: scope.agentInstanceId,
          chunkIndex: chunk.index,
          chunkText: chunk.text,
          snippet: chunk.snippet,
          embedding,
        });
      }

      await client.query('COMMIT');
      return { id: memoryId };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Replace project-level archival memory for one external source (e.g. Feishu doc/table).
   * Existing records with the same source key are removed and rebuilt with new chunks.
   */
  async replace_archival_document(input: ReplaceArchivalDocumentInput): Promise<{ id: string; replaced: number }> {
    const projectShared = input.project_shared ?? true;
    const sourceScope = projectShared
      ? {
          ...input.scope,
          user_id: PROJECT_SHARED_USER_ID,
        }
      : input.scope;
    const scope = toMemoryScopeContext(sourceScope);
    if (projectShared && !scope.projectId) {
      throw new Error('project_id is required for project-shared archival documents');
    }

    const chunkInputs = input.chunks
      .map((chunk) => ({
        text: chunk.text.trim(),
        snippet: chunk.snippet?.trim() || '',
        metadata: chunk.metadata ?? {},
      }))
      .filter((chunk) => chunk.text.length > 0);
    const chunkTexts = chunkInputs.map((chunk) => chunk.text);
    const embeddings = chunkTexts.length > 0
      ? await this.embeddingProvider.embedBatch(chunkTexts)
      : [];

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const existing = await client.query<{ id: string }>(
        `SELECT id::text AS id
        FROM memories
        WHERE org_id = $1
          AND user_id = $2
          AND project_id IS NOT DISTINCT FROM $3
          AND type = 'archival'
          AND metadata->>'source_type' = $4
          AND metadata->>'source_key' = $5`,
        [
          scope.orgId,
          scope.userId,
          scope.projectId,
          input.source.source_type,
          input.source.source_key,
        ]
      );
      const replaced = existing.rows.length;
      if (replaced > 0) {
        const ids = existing.rows.map((row) => row.id);
        await client.query(
          `DELETE FROM memories WHERE id = ANY($1::uuid[])`,
          [ids]
        );
      }

      const mergedMetadata: Record<string, unknown> = {
        ...(input.metadata ?? {}),
        source_type: input.source.source_type,
        source_key: input.source.source_key,
        project_shared: projectShared,
      };

      const memoryResult = await client.query<{ id: string }>(
        `INSERT INTO memories (
          org_id,
          user_id,
          project_id,
          group_id,
          agent_instance_id,
          type,
          text,
          metadata,
          importance
        ) VALUES ($1, $2, $3, NULL, NULL, 'archival', $4, $5::jsonb, $6)
        RETURNING id::text AS id`,
        [
          scope.orgId,
          scope.userId,
          scope.projectId,
          input.text,
          JSON.stringify(mergedMetadata),
          input.importance ?? 0.8,
        ]
      );
      const memoryId = memoryResult.rows[0]?.id;
      if (!memoryId) {
        throw new Error('Failed to insert archival document');
      }

      for (let i = 0; i < chunkInputs.length; i++) {
        const chunk = chunkInputs[i];
        const embedding = embeddings[i];
        if (!chunk || !embedding) {
          continue;
        }
        await this.insertChunk(client, {
          memoryId,
          orgId: scope.orgId,
          userId: scope.userId,
          projectId: scope.projectId,
          groupId: null,
          agentInstanceId: null,
          chunkIndex: i,
          chunkText: chunk.text,
          snippet: chunk.snippet || chunk.text.slice(0, 180),
          embedding,
          metadata: chunk.metadata,
        });
      }

      await client.query('COMMIT');
      return {
        id: memoryId,
        replaced,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async memory_get(id: string, scope: MemoryScope): Promise<MemoryGetResponse | null> {
    const scopeContext = toScopeContext(scope);
    const directPredicates: string[] = ['id = $1::uuid'];
    const directParams: unknown[] = [id];
    appendScopePredicate(directPredicates, directParams, scopeContext);

    const direct = await this.pool.query<MemoryRow>(
      `SELECT id::text AS id, type, text, metadata, created_at, updated_at
      FROM memories
      WHERE ${directPredicates.join(' AND ')}
      LIMIT 1`,
      directParams
    );
    const directRow = direct.rows[0];
    if (directRow) {
      return {
        id: directRow.id,
        type: directRow.type,
        text: directRow.text,
        metadata: directRow.metadata ?? {},
        created_at: toIso(directRow.created_at),
        updated_at: toIso(directRow.updated_at),
      };
    }

    if (!scopeContext.projectId) {
      return null;
    }

    const shared = await this.pool.query<MemoryRow>(
      `SELECT id::text AS id, type, text, metadata, created_at, updated_at
      FROM memories
      WHERE id = $1::uuid
        AND org_id = $2
        AND project_id IS NOT DISTINCT FROM $3
        AND user_id = $4
        AND type = 'archival'
        AND COALESCE(metadata->>'source_type', '') LIKE 'feishu_%'
      LIMIT 1`,
      [id, scopeContext.orgId, scopeContext.projectId, PROJECT_SHARED_USER_ID]
    );
    const sharedRow = shared.rows[0];
    if (!sharedRow) {
      return null;
    }
    return {
      id: sharedRow.id,
      type: sharedRow.type,
      text: sharedRow.text,
      metadata: sharedRow.metadata ?? {},
      created_at: toIso(sharedRow.created_at),
      updated_at: toIso(sharedRow.updated_at),
    };
  }

  async memory_delete(id: string, scope: MemoryScope): Promise<{ deleted: boolean }> {
    const scopeContext = toScopeContext(scope);
    const predicates: string[] = ['id = $1::uuid'];
    const params: unknown[] = [id];
    appendScopePredicate(predicates, params, scopeContext);

    // Delete chunks first (foreign key), then memory
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `DELETE FROM memory_chunks WHERE memory_id = $1::uuid`,
        [id]
      );
      const result = await client.query(
        `DELETE FROM memories WHERE ${predicates.join(' AND ')}`,
        params
      );
      await client.query('COMMIT');
      return { deleted: (result.rowCount ?? 0) > 0 };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async memory_list(
    scope: MemoryScope,
    opts?: { type?: string; limit?: number; offset?: number }
  ): Promise<{ items: Array<{ id: string; type: string; text: string; created_at: string }>; total: number }> {
    const scopeContext = toScopeContext(scope);
    const predicates: string[] = [];
    const params: unknown[] = [];
    appendScopePredicate(predicates, params, scopeContext);

    if (opts?.type && ['core', 'episodic', 'archival'].includes(opts.type)) {
      params.push(opts.type);
      predicates.push(`type = $${params.length}`);
    }

    const limit = Math.min(opts?.limit ?? 20, 100);
    const offset = opts?.offset ?? 0;

    const countResult = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM memories WHERE ${predicates.join(' AND ')}`,
      params
    );
    const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

    params.push(limit, offset);
    const rows = await this.pool.query<{ id: string; type: string; text: string; created_at: string | Date }>(
      `SELECT id::text AS id, type, LEFT(text, 200) AS text, created_at
       FROM memories WHERE ${predicates.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return {
      items: rows.rows.map((r) => ({
        id: r.id,
        type: r.type,
        text: r.text,
        created_at: toIso(r.created_at),
      })),
      total,
    };
  }

  async memory_search(input: MemorySearchInput): Promise<MemorySearchResult[]> {
    const scope = toMemoryScopeContext(input.scope);
    const topK = Math.max(1, Math.min(input.top_k, 50));
    const typeFilters = extractTypeFilter(input.filters);
    const embedding = await this.embeddingProvider.embed(input.query);
    const vectorRows = await this.vectorSearch(scope, toVectorLiteral(embedding), topK, typeFilters);
    const ftsRows = await this.ftsSearch(scope, input.query, topK, typeFilters);

    const vectorScores = normalizeScores(vectorRows);
    const ftsScores = normalizeScores(ftsRows);
    const merged = new Map<string, MemorySearchResult>();

    const collect = (rows: SearchRow[], source: 'vector' | 'fts'): void => {
      for (const row of rows) {
        const vectorScore = vectorScores.get(row.id) ?? 0;
        const ftsScore = ftsScores.get(row.id) ?? 0;
        const score = vectorScore * 0.6 + ftsScore * 0.4;
        const existing = merged.get(row.id);
        if (!existing || score > existing.score) {
          merged.set(row.id, {
            id: row.id,
            snippet: row.snippet,
            score,
            type: row.type,
          });
        } else if (source === 'fts' && existing.snippet.length < row.snippet.length) {
          existing.snippet = row.snippet;
          merged.set(row.id, existing);
        }
      }
    };

    collect(vectorRows, 'vector');
    collect(ftsRows, 'fts');

    return [...merged.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /**
   * Tiered memory search across group blackboard, project core,
   * personal episodic, and archival scopes.
   */
  async memory_search_tiered(input: TieredSearchInput): Promise<MemorySearchResult[]> {
    const topK = Math.max(1, Math.min(input.top_k, 50));
    const baseScope = input.scope;
    const groupId = input.group_id;
    const agentInstanceId = input.agent_instance_id;

    // Allocate budget per tier
    const tier1K = Math.ceil(topK / 2);       // group blackboard
    const remaining = topK - tier1K;
    const tier2K = Math.ceil(remaining / 3);   // project core
    const tier3K = Math.ceil(remaining / 3);   // personal episodic
    const tier4K = remaining - tier2K - tier3K; // archival

    const merged = new Map<string, MemorySearchResult>();

    const addResults = (results: MemorySearchResult[]): void => {
      for (const r of results) {
        const existing = merged.get(r.id);
        if (!existing || r.score > existing.score) {
          merged.set(r.id, r);
        }
      }
    };

    // Tier 1: Group blackboard (core + episodic with group_id)
    if (groupId) {
      const t1 = await this.memory_search({
        query: input.query,
        scope: { ...baseScope, group_id: groupId },
        top_k: tier1K,
        filters: { types: ['core', 'episodic'] },
      });
      addResults(t1);
    }

    // Tier 2: Project core
    const t2 = await this.memory_search({
      query: input.query,
      scope: { ...baseScope, group_id: undefined, agent_instance_id: undefined },
      top_k: tier2K,
      filters: { type: 'core' },
    });
    addResults(t2);

    // Tier 3: Personal episodic
    if (agentInstanceId) {
      const t3 = await this.memory_search({
        query: input.query,
        scope: { ...baseScope, agent_instance_id: agentInstanceId, group_id: undefined },
        top_k: tier3K,
        filters: { type: 'episodic' },
      });
      addResults(t3);
    }

    // Tier 4: Archival
    const t4 = await this.memory_search({
      query: input.query,
      scope: { ...baseScope, group_id: undefined, agent_instance_id: undefined },
      top_k: tier4K,
      filters: { type: 'archival' },
    });
    addResults(t4);

    return [...merged.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /**
   * PA-specific memory search with 3-tier retrieval priority:
   *   Tier 1: User preferences (core memories with pa_preference metadata)
   *   Tier 2: Enterprise knowledge (org-level archival memories)
   *   Tier 3: Historical task memory (user+project episodic memories)
   */
  async memory_search_pa(input: {
    query: string;
    scope: MemoryScope;
    top_k?: number;
    agent_instance_id?: string;
  }): Promise<MemorySearchResult[]> {
    const topK = Math.max(1, Math.min(input.top_k ?? 10, 50));
    const baseScope = input.scope;

    // Budget allocation per tier
    const tier1K = Math.ceil(topK * 0.3);  // user preferences
    const tier2K = Math.ceil(topK * 0.4);  // enterprise knowledge
    const tier3K = topK - tier1K - tier2K;  // historical task memory

    const merged = new Map<string, MemorySearchResult>();

    const addResults = (results: MemorySearchResult[]): void => {
      for (const r of results) {
        const existing = merged.get(r.id);
        if (!existing || r.score > existing.score) {
          merged.set(r.id, r);
        }
      }
    };

    // Tier 1: User preferences (core type, scoped to user + agentInstance)
    const t1 = await this.memory_search({
      query: input.query,
      scope: {
        org_id: baseScope.org_id,
        user_id: baseScope.user_id,
        ...(input.agent_instance_id ? { agent_instance_id: input.agent_instance_id } : {}),
      },
      top_k: tier1K,
      filters: { type: 'core' },
    });
    addResults(t1);

    // Tier 2: Enterprise knowledge (org-level archival, no user/project/group)
    const t2 = await this.memory_search({
      query: input.query,
      scope: {
        org_id: baseScope.org_id,
        user_id: baseScope.user_id,
      },
      top_k: tier2K,
      filters: { type: 'archival' },
    });
    addResults(t2);

    // Tier 3: Historical task memory (user+project episodic, no group)
    if (baseScope.project_id) {
      const t3 = await this.memory_search({
        query: input.query,
        scope: {
          org_id: baseScope.org_id,
          user_id: baseScope.user_id,
          project_id: baseScope.project_id,
        },
        top_k: tier3K,
        filters: { type: 'episodic' },
      });
      addResults(t3);
    }

    return [...merged.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /**
   * Write to group blackboard with role-based access control.
   * Only leads can write core/decision-tagged memories.
   */
  async blackboard_write(input: BlackboardWriteRequest): Promise<{ id: string }> {
    const isCoreOrDecision =
      input.type === 'core' ||
      (input.metadata && input.metadata['episodic_type'] === 'DECISION');

    if (isCoreOrDecision && !input.is_lead) {
      throw new Error('Only lead roles can write core/decision memories to the blackboard');
    }

    return this.memory_write({
      type: input.type,
      scope: {
        ...input.scope,
        group_id: input.group_id,
      },
      text: input.text,
      metadata: {
        ...input.metadata,
        blackboard: true,
        role_id: input.role_id,
      },
      importance: input.importance,
    });
  }

  /**
   * List blackboard memories for a group.
   */
  async blackboard_list(
    groupId: string,
    scope: MemoryScope,
    limit: number = 50
  ): Promise<Array<MemoryGetResponse & { group_id: string }>> {
    const scopeCtx = toScopeContext(scope);
    const predicates: string[] = [];
    const params: unknown[] = [];
    appendScopePredicate(predicates, params, scopeCtx);
    const groupIdx = params.push(groupId);
    predicates.push(`group_id = $${groupIdx}`);
    const limitIdx = params.push(limit);

    const result = await this.pool.query<MemoryRow & { group_id: string }>(
      `SELECT id::text AS id, type, text, metadata, created_at, updated_at, group_id
      FROM memories
      WHERE ${predicates.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${limitIdx}`,
      params
    );

    return result.rows.map((row) => ({
      id: row.id,
      type: row.type,
      text: row.text,
      metadata: row.metadata ?? {},
      created_at: toIso(row.created_at),
      updated_at: toIso(row.updated_at),
      group_id: row.group_id,
    }));
  }

  private async vectorSearch(
    scope: MemoryScopeContext,
    vectorLiteral: string,
    topK: number,
    typeFilters: MemoryType[]
  ): Promise<SearchRow[]> {
    const predicates: string[] = [];
    const params: unknown[] = [];
    this.appendChunkScopePredicate(predicates, params, scope, 'mc', 'm');
    if (typeFilters.length > 0) {
      const filterIndex = params.push(typeFilters);
      predicates.push(`m.type = ANY($${filterIndex}::text[])`);
    }
    const vectorIndex = params.push(vectorLiteral);
    const limitIndex = params.push(topK * 3);
    const whereSql = predicates.length > 0 ? `WHERE ${predicates.join(' AND ')}` : '';

    const result = await this.pool.query<SearchRow>(
      `SELECT
        mc.memory_id::text AS id,
        m.type AS type,
        mc.snippet AS snippet,
        (1 - (mc.embedding <=> $${vectorIndex}::vector))::float8 AS score
      FROM memory_chunks mc
      JOIN memories m ON m.id = mc.memory_id
      ${whereSql}
      ORDER BY mc.embedding <=> $${vectorIndex}::vector ASC
      LIMIT $${limitIndex}`,
      params
    );

    if (result.rows.length === 0) {
      return [];
    }

    return this.keepBestRows(result.rows);
  }

  private async ftsSearch(
    scope: MemoryScopeContext,
    query: string,
    topK: number,
    typeFilters: MemoryType[]
  ): Promise<SearchRow[]> {
    const predicates: string[] = [];
    const params: unknown[] = [];
    this.appendChunkScopePredicate(predicates, params, scope, 'mc', 'm');
    if (typeFilters.length > 0) {
      const filterIndex = params.push(typeFilters);
      predicates.push(`m.type = ANY($${filterIndex}::text[])`);
    }
    const queryIndex = params.push(query);
    predicates.push(`mc.search_tsv @@ plainto_tsquery('simple', $${queryIndex})`);
    const limitIndex = params.push(topK * 3);

    const result = await this.pool.query<SearchRow>(
      `SELECT
        mc.memory_id::text AS id,
        m.type AS type,
        COALESCE(
          ts_headline(
            'simple',
            mc.chunk_text,
            plainto_tsquery('simple', $${queryIndex}),
            'StartSel=,StopSel=,MaxFragments=1,MaxWords=20,MinWords=8'
          ),
          mc.snippet
        ) AS snippet,
        ts_rank_cd(mc.search_tsv, plainto_tsquery('simple', $${queryIndex}))::float8 AS score
      FROM memory_chunks mc
      JOIN memories m ON m.id = mc.memory_id
      WHERE ${predicates.join(' AND ')}
      ORDER BY score DESC
      LIMIT $${limitIndex}`,
      params
    );

    if (result.rows.length === 0) {
      return [];
    }

    return this.keepBestRows(result.rows);
  }

  private appendChunkScopePredicate(
    predicates: string[],
    params: unknown[],
    scope: MemoryScopeContext,
    chunkAlias: string,
    memoryAlias: string
  ): void {
    const orgIdx = params.push(scope.orgId);
    predicates.push(`${chunkAlias}.org_id = $${orgIdx}`);

    const projectIdx = params.push(scope.projectId);
    predicates.push(`${chunkAlias}.project_id IS NOT DISTINCT FROM $${projectIdx}`);

    const userIdx = params.push(scope.userId);
    if (scope.projectId) {
      const sharedUserIdx = params.push(PROJECT_SHARED_USER_ID);
      predicates.push(
        `(${chunkAlias}.user_id = $${userIdx} OR (` +
        `${chunkAlias}.user_id = $${sharedUserIdx} ` +
        `AND ${memoryAlias}.type = 'archival' ` +
        `AND COALESCE(${memoryAlias}.metadata->>'source_type', '') LIKE 'feishu_%'))`
      );
    } else {
      predicates.push(`${chunkAlias}.user_id = $${userIdx}`);
    }

    if (scope.groupId) {
      const groupIdx = params.push(scope.groupId);
      predicates.push(`${chunkAlias}.group_id = $${groupIdx}`);
    }

    if (scope.agentInstanceId) {
      const agentIdx = params.push(scope.agentInstanceId);
      predicates.push(`${chunkAlias}.agent_instance_id = $${agentIdx}`);
    }
  }

  private keepBestRows(rows: SearchRow[]): SearchRow[] {
    const byMemory = new Map<string, SearchRow>();
    for (const row of rows) {
      const existing = byMemory.get(row.id);
      if (!existing || row.score > existing.score) {
        byMemory.set(row.id, row);
      }
    }
    return [...byMemory.values()];
  }

  private async insertChunk(
    client: IPostgresClient,
    input: {
      memoryId: string;
      orgId: string;
      userId: string;
      projectId: string | null;
      groupId: string | null;
      agentInstanceId: string | null;
      chunkIndex: number;
      chunkText: string;
      snippet: string;
      embedding: number[];
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    await client.query(
      `INSERT INTO memory_chunks (
        memory_id,
        org_id,
        user_id,
        project_id,
        group_id,
        agent_instance_id,
        chunk_index,
        chunk_text,
        snippet,
        embedding,
        metadata
      ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector, $11::jsonb)`,
      [
        input.memoryId,
        input.orgId,
        input.userId,
        input.projectId,
        input.groupId,
        input.agentInstanceId,
        input.chunkIndex,
        input.chunkText,
        input.snippet,
        toVectorLiteral(input.embedding),
        JSON.stringify(input.metadata ?? {}),
      ]
    );
  }
}


