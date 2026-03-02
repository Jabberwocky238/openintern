import { randomUUID } from 'node:crypto';
import type {
  IMemoryRepository,
  MemorySearchInput,
  MemoryWriteRequestRepo,
  ReplaceArchivalDocumentInput,
} from '../interfaces/memory-repository.js';
import type {
  MemoryGetResponse,
  MemoryScope,
  MemorySearchResult,
  MemoryType,
  TieredSearchInput,
} from '@openintern/types/memory.js';
import { resolveMemoryRepositoryStore, type MemoryRepositoryStore } from './store.js';

interface StoredMemoryRecord {
  id: string;
  org_id: string;
  user_id: string;
  project_id: string | null;
  group_id: string | null;
  agent_instance_id: string | null;
  type: MemoryType;
  text: string;
  metadata: Record<string, unknown>;
  importance: number;
  created_at: string;
  updated_at: string;
}

const PROJECT_SHARED_USER_ID = 'user_project_shared';

function computeScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (!q || !t) return 0;
  if (t.includes(q)) return 1;
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  let hits = 0;
  for (const token of tokens) {
    if (t.includes(token)) hits += 1;
  }
  return hits / tokens.length;
}

export class MemoryRepository implements IMemoryRepository {
  private readonly store: MemoryRepositoryStore;

  constructor(_ignored?: unknown, store?: MemoryRepositoryStore) {
    this.store = resolveMemoryRepositoryStore(store);
  }

  async memory_write(input: MemoryWriteRequestRepo): Promise<{ id: string }> {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.store.memories.set(id, {
      id,
      org_id: input.scope.org_id,
      user_id: input.scope.user_id,
      project_id: input.scope.project_id ?? null,
      group_id: input.scope.group_id ?? null,
      agent_instance_id: input.scope.agent_instance_id ?? null,
      type: input.type,
      text: input.text,
      metadata: input.metadata ?? {},
      importance: input.importance ?? 0.5,
      created_at: now,
      updated_at: now,
    });
    return { id };
  }

  async replace_archival_document(input: ReplaceArchivalDocumentInput): Promise<{ id: string; replaced: number }> {
    const projectShared = input.project_shared ?? true;
    const userId = projectShared ? PROJECT_SHARED_USER_ID : input.scope.user_id;
    if (projectShared && !input.scope.project_id) {
      throw new Error('project_id is required for project-shared archival documents');
    }
    const idsToDelete: string[] = [];
    for (const memory of this.store.memories.values()) {
      if (
        memory.org_id === input.scope.org_id &&
        memory.user_id === userId &&
        memory.project_id === (input.scope.project_id ?? null) &&
        memory.type === 'archival' &&
        String(memory.metadata['source_type'] ?? '') === input.source.source_type &&
        String(memory.metadata['source_key'] ?? '') === input.source.source_key
      ) {
        idsToDelete.push(memory.id);
      }
    }
    for (const id of idsToDelete) {
      this.store.memories.delete(id);
    }
    const mergedMetadata = {
      ...(input.metadata ?? {}),
      source_type: input.source.source_type,
      source_key: input.source.source_key,
      project_shared: projectShared,
    };
    const created = await this.memory_write({
      type: 'archival',
      scope: {
        org_id: input.scope.org_id,
        user_id: userId,
        ...(input.scope.project_id ? { project_id: input.scope.project_id } : {}),
      },
      text: input.text,
      metadata: mergedMetadata,
      importance: input.importance ?? 0.8,
    });
    return { id: created.id, replaced: idsToDelete.length };
  }

  async memory_get(id: string, scope: MemoryScope): Promise<MemoryGetResponse | null> {
    const memory = this.store.memories.get(id);
    if (!memory) return null;
    if (!this.isVisible(memory, scope)) return null;
    return this.toResponse(memory);
  }

  async memory_delete(id: string, scope: MemoryScope): Promise<{ deleted: boolean }> {
    const memory = this.store.memories.get(id);
    if (!memory) return { deleted: false };
    if (!this.isDirectScopeMatch(memory, scope)) return { deleted: false };
    this.store.memories.delete(id);
    return { deleted: true };
  }

  async memory_list(
    scope: MemoryScope,
    opts?: { type?: string; limit?: number; offset?: number }
  ): Promise<{ items: Array<{ id: string; type: string; text: string; created_at: string }>; total: number }> {
    const visible = [...this.store.memories.values()]
      .filter((memory) => this.isDirectScopeMatch(memory, scope))
      .filter((memory) => (opts?.type ? memory.type === opts.type : true))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const total = visible.length;
    const limit = Math.min(opts?.limit ?? 20, 100);
    const offset = Math.max(opts?.offset ?? 0, 0);
    return {
      items: visible.slice(offset, offset + limit).map((memory) => ({
        id: memory.id,
        type: memory.type,
        text: memory.text.slice(0, 200),
        created_at: memory.created_at,
      })),
      total,
    };
  }

  async memory_search(input: MemorySearchInput): Promise<MemorySearchResult[]> {
    const topK = Math.max(1, Math.min(input.top_k, 50));
    const filterType = typeof input.filters?.['type'] === 'string' ? input.filters['type'] : null;
    const filtered = [...this.store.memories.values()]
      .filter((memory) => this.isVisible(memory, input.scope))
      .filter((memory) => (filterType ? memory.type === filterType : true))
      .map((memory) => ({
        id: memory.id,
        type: memory.type,
        snippet: memory.text.slice(0, 240),
        score: computeScore(input.query, memory.text),
      }))
      .filter((memory) => memory.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    return filtered;
  }

  async memory_search_tiered(input: TieredSearchInput): Promise<MemorySearchResult[]> {
    return this.memory_search({
      query: input.query,
      scope: {
        ...input.scope,
        ...(input.group_id ? { group_id: input.group_id } : {}),
        ...(input.agent_instance_id ? { agent_instance_id: input.agent_instance_id } : {}),
      },
      top_k: input.top_k,
    });
  }

  async memory_search_pa(input: {
    query: string;
    scope: MemoryScope;
    top_k?: number;
    agent_instance_id?: string;
  }): Promise<MemorySearchResult[]> {
    return this.memory_search({
      query: input.query,
      scope: {
        ...input.scope,
        ...(input.agent_instance_id ? { agent_instance_id: input.agent_instance_id } : {}),
      },
      top_k: input.top_k ?? 10,
    });
  }

  async blackboard_list(
    groupId: string,
    scope: MemoryScope,
    limit: number = 50
  ): Promise<Array<MemoryGetResponse & { group_id: string }>> {
    return [...this.store.memories.values()]
      .filter((memory) => memory.group_id === groupId)
      .filter((memory) => this.isDirectScopeMatch(memory, scope))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, Math.max(1, limit))
      .map((memory) => ({
        ...this.toResponse(memory),
        group_id: groupId,
      }));
  }

  private isDirectScopeMatch(memory: StoredMemoryRecord, scope: MemoryScope): boolean {
    return (
      memory.org_id === scope.org_id &&
      memory.user_id === scope.user_id &&
      memory.project_id === (scope.project_id ?? null) &&
      (scope.group_id ? memory.group_id === scope.group_id : true) &&
      (scope.agent_instance_id ? memory.agent_instance_id === scope.agent_instance_id : true)
    );
  }

  private isVisible(memory: StoredMemoryRecord, scope: MemoryScope): boolean {
    if (this.isDirectScopeMatch(memory, scope)) return true;
    if (!scope.project_id) return false;
    return (
      memory.org_id === scope.org_id &&
      memory.project_id === scope.project_id &&
      memory.user_id === PROJECT_SHARED_USER_ID &&
      memory.type === 'archival' &&
      String(memory.metadata['source_type'] ?? '').startsWith('feishu_')
    );
  }

  private toResponse(memory: StoredMemoryRecord): MemoryGetResponse {
    return {
      id: memory.id,
      type: memory.type,
      text: memory.text,
      metadata: memory.metadata,
      created_at: memory.created_at,
      updated_at: memory.updated_at,
    };
  }
}


