import type {
  MemoryGetResponse,
  MemoryScope,
  MemorySearchResult,
  MemoryType,
  TieredSearchInput,
} from '@openintern/types/memory.js';

export interface MemorySearchInput {
  query: string;
  scope: MemoryScope;
  top_k: number;
  filters?: Record<string, unknown>;
}

export interface FeishuChunkInput {
  text: string;
  snippet?: string;
  metadata?: Record<string, unknown>;
}

export interface ReplaceArchivalDocumentInput {
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

export interface MemoryWriteRequestRepo {
  type: MemoryType;
  scope: MemoryScope;
  text: string;
  metadata?: Record<string, unknown>;
  importance?: number;
}

export interface IMemoryRepository {
  memory_write(input: MemoryWriteRequestRepo): Promise<{ id: string }>;
  replace_archival_document(input: ReplaceArchivalDocumentInput): Promise<{ id: string; replaced: number }>;
  memory_get(id: string, scope: MemoryScope): Promise<MemoryGetResponse | null>;
  memory_delete(id: string, scope: MemoryScope): Promise<{ deleted: boolean }>;
  memory_list(
    scope: MemoryScope,
    opts?: { type?: string; limit?: number; offset?: number }
  ): Promise<{ items: Array<{ id: string; type: string; text: string; created_at: string }>; total: number }>;
  memory_search(input: MemorySearchInput): Promise<MemorySearchResult[]>;
  memory_search_tiered(input: TieredSearchInput): Promise<MemorySearchResult[]>;
  memory_search_pa(input: {
    query: string;
    scope: MemoryScope;
    top_k?: number;
    agent_instance_id?: string;
  }): Promise<MemorySearchResult[]>;
  blackboard_list(
    groupId: string,
    scope: MemoryScope,
    limit?: number
  ): Promise<Array<MemoryGetResponse & { group_id: string }>>;
}

