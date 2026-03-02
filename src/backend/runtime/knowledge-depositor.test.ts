import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KnowledgeDepositor } from './knowledge-depositor.js';
import type { RunRepository } from '@openintern/repository/postgres';
import type { MemoryService } from './memory-service.js';
import type { RunRecord } from './models.js';

function createMockRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run_child123456',
    orgId: 'org_test',
    userId: 'user_test',
    projectId: null,
    groupId: null,
    sessionKey: 's_test',
    input: 'test input',
    status: 'completed',
    agentId: 'orchestrator',
    llmConfig: null,
    result: null,
    error: null,
    parentRunId: null,
    delegatedPermissions: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    endedAt: null,
    cancelledAt: null,
    suspendedAt: null,
    suspendReason: null,
    ...overrides,
  };
}

describe('KnowledgeDepositor', () => {
  let depositor: KnowledgeDepositor;
  let runRepository: {
    getRunById: ReturnType<typeof vi.fn>;
  };
  let memoryService: {
    memory_write: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    runRepository = {
      getRunById: vi.fn(),
    };
    memoryService = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      memory_write: vi.fn().mockResolvedValue({ id: 'mem_123' }),
    };
    depositor = new KnowledgeDepositor({
      memoryService: memoryService as unknown as MemoryService,
      runRepository: runRepository as unknown as RunRepository,
    });
  });

  describe('depositGroupResults', () => {
    it('should deposit episodic memory when child run has a parent', async () => {
      runRepository.getRunById.mockResolvedValue(
        createMockRunRecord({
          id: 'run_child123456',
          parentRunId: 'run_parent12345',
        })
      );

      await depositor.depositGroupResults(
        'run_child123456',
        { orgId: 'org_test', userId: 'user_test', projectId: null },
        'The analysis is complete.'
      );

      expect(memoryService.memory_write).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'episodic',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          scope: expect.objectContaining({
            org_id: 'org_test',
            user_id: 'user_test',
          }),
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          text: expect.stringContaining('run_child123456'),
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          metadata: expect.objectContaining({
            episodic_type: 'GROUP_RESULT',
            child_run_id: 'run_child123456',
            parent_run_id: 'run_parent12345',
          }),
          importance: 0.7,
        })
      );
    });

    it('should no-op when child run has no parent_run_id', async () => {
      runRepository.getRunById.mockResolvedValue(
        createMockRunRecord({ parentRunId: null })
      );

      await depositor.depositGroupResults(
        'run_child123456',
        { orgId: 'org_test', userId: 'user_test', projectId: null },
        'output'
      );

      expect(memoryService.memory_write).not.toHaveBeenCalled();
    });

    it('should no-op when child run is not found', async () => {
      runRepository.getRunById.mockResolvedValue(null);

      await depositor.depositGroupResults(
        'run_nonexistent',
        { orgId: 'org_test', userId: 'user_test', projectId: null },
        'output'
      );

      expect(memoryService.memory_write).not.toHaveBeenCalled();
    });

    it('should truncate long output to 2000 chars', async () => {
      runRepository.getRunById.mockResolvedValue(
        createMockRunRecord({ parentRunId: 'run_parent12345' })
      );

      const longOutput = 'x'.repeat(3000);

      await depositor.depositGroupResults(
        'run_child123456',
        { orgId: 'org_test', userId: 'user_test', projectId: null },
        longOutput
      );

      const call = memoryService.memory_write.mock.calls[0]?.[0] as { text: string };
      // The text includes the prefix, so check the output portion is truncated
      expect(call.text).toContain('...');
      expect(call.text.length).toBeLessThan(3100);
    });

    it('should include project_id in scope when available', async () => {
      runRepository.getRunById.mockResolvedValue(
        createMockRunRecord({ parentRunId: 'run_parent12345' })
      );

      await depositor.depositGroupResults(
        'run_child123456',
        { orgId: 'org_test', userId: 'user_test', projectId: 'proj_abc' },
        'output'
      );

      expect(memoryService.memory_write).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          scope: expect.objectContaining({
            project_id: 'proj_abc',
          }),
        })
      );
    });

    it('should not throw when memory_write fails', async () => {
      runRepository.getRunById.mockResolvedValue(
        createMockRunRecord({ parentRunId: 'run_parent12345' })
      );
      memoryService.memory_write.mockRejectedValue(new Error('DB error'));

      // Should not throw
      await depositor.depositGroupResults(
        'run_child123456',
        { orgId: 'org_test', userId: 'user_test', projectId: null },
        'output'
      );
    });
  });
});
