import type {
  BlackboardWriteRequest,
  MemoryGetResponse,
  MemoryScope,
  MemorySearchResult,
  MemoryWriteRequest,
  TieredSearchInput,
} from '@openintern/types/memory.js';
import type {
  IMemoryRepository,
  MemorySearchInput,
  ReplaceArchivalDocumentInput,
} from '@openintern/repository';

export class MemoryService {
  constructor(private readonly repository: IMemoryRepository) {}

  async memory_write(input: MemoryWriteRequest): Promise<{ id: string }> {
    return this.repository.memory_write(input);
  }

  async replace_archival_document(input: ReplaceArchivalDocumentInput): Promise<{ id: string; replaced: number }> {
    return this.repository.replace_archival_document(input);
  }

  async memory_get(id: string, scope: MemoryScope): Promise<MemoryGetResponse | null> {
    return this.repository.memory_get(id, scope);
  }

  async memory_delete(id: string, scope: MemoryScope): Promise<{ deleted: boolean }> {
    return this.repository.memory_delete(id, scope);
  }

  async memory_list(
    scope: MemoryScope,
    opts?: { type?: string; limit?: number; offset?: number }
  ): Promise<{ items: Array<{ id: string; type: string; text: string; created_at: string }>; total: number }> {
    return this.repository.memory_list(scope, opts);
  }

  async memory_search(input: MemorySearchInput): Promise<MemorySearchResult[]> {
    return this.repository.memory_search(input);
  }

  async memory_search_tiered(input: TieredSearchInput): Promise<MemorySearchResult[]> {
    return this.repository.memory_search_tiered(input);
  }

  async memory_search_pa(input: {
    query: string;
    scope: MemoryScope;
    top_k?: number;
    agent_instance_id?: string;
  }): Promise<MemorySearchResult[]> {
    return this.repository.memory_search_pa(input);
  }

  async blackboard_write(input: BlackboardWriteRequest): Promise<{ id: string }> {
    const isCoreOrDecision =
      input.type === 'core' ||
      (input.metadata && input.metadata['episodic_type'] === 'DECISION');

    if (isCoreOrDecision && !input.is_lead) {
      throw new Error('Only lead roles can write core/decision memories to the blackboard');
    }

    return this.repository.memory_write({
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

  async blackboard_list(
    groupId: string,
    scope: MemoryScope,
    limit: number = 50
  ): Promise<Array<MemoryGetResponse & { group_id: string }>> {
    return this.repository.blackboard_list(groupId, scope, limit);
  }
}
