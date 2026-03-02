import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EscalationService } from './escalation-service.js';
import type { RunRepository } from '../repository/postgres/run-repository.js';
import type { GroupRepository } from '../repository/postgres/group-repository.js';
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
    status: 'pending',
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

describe('EscalationService', () => {
  let service: EscalationService;
  let runRepository: {
    createRun: ReturnType<typeof vi.fn>;
    setRunWaiting: ReturnType<typeof vi.fn>;
    setRunResumed: ReturnType<typeof vi.fn>;
    getRunById: ReturnType<typeof vi.fn>;
  };
  let groupRepository: {
    getGroup: ReturnType<typeof vi.fn>;
    listMembers: ReturnType<typeof vi.fn>;
    listGroups: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    runRepository = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      createRun: vi.fn().mockResolvedValue(createMockRunRecord()),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      setRunWaiting: vi.fn().mockResolvedValue(undefined),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      setRunResumed: vi.fn().mockResolvedValue(undefined),
      getRunById: vi.fn(),
    };
    groupRepository = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      getGroup: vi.fn().mockResolvedValue({
        id: 'grp_test123456',
        name: 'Test Group',
        description: 'A test group',
        project_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      listMembers: vi.fn().mockResolvedValue([
        {
          id: 'gm_member1',
          group_id: 'grp_test123456',
          role_id: 'role_test1',
          agent_instance_id: 'ai_inst1',
          ordinal: 0,
          created_at: new Date().toISOString(),
        },
      ]),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      listGroups: vi.fn().mockResolvedValue([
        {
          id: 'grp_test123456',
          name: 'Test Group',
          description: 'A test group',
          project_id: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]),
    };

    service = new EscalationService({
      runRepository: runRepository as unknown as RunRepository,
      groupRepository: groupRepository as unknown as GroupRepository,
      timeoutMs: 500,
      pollIntervalMs: 50,
    });
  });

  describe('escalate', () => {
    it('should create a child run and set parent to waiting', async () => {
      runRepository.getRunById.mockResolvedValue(
        createMockRunRecord({
          status: 'completed',
          result: { output: 'Group result here' },
        })
      );

      const result = await service.escalate({
        parentRunId: 'run_parent12345',
        scope: { orgId: 'org_test', userId: 'user_test', projectId: null },
        sessionKey: 's_test',
        groupId: 'grp_test123456',
        goal: 'Analyze the data',
      });

      expect(runRepository.createRun).toHaveBeenCalledWith(
        expect.objectContaining({
          input: 'Goal: Analyze the data',
          agentId: 'orchestrator',
          parentRunId: 'run_parent12345',
        })
      );
      expect(runRepository.setRunWaiting).toHaveBeenCalledWith('run_parent12345');
      expect(runRepository.setRunResumed).toHaveBeenCalledWith('run_parent12345');
      expect(result.success).toBe(true);
      expect(result.result).toBe('Group result here');
    });

    it('should include context in child run input when provided', async () => {
      runRepository.getRunById.mockResolvedValue(
        createMockRunRecord({
          status: 'completed',
          result: { output: 'done' },
        })
      );

      await service.escalate({
        parentRunId: 'run_parent12345',
        scope: { orgId: 'org_test', userId: 'user_test', projectId: null },
        sessionKey: 's_test',
        groupId: 'grp_test123456',
        goal: 'Analyze the data',
        context: 'Previous conversation about metrics',
      });

      expect(runRepository.createRun).toHaveBeenCalledWith(
        expect.objectContaining({
          input: 'Goal: Analyze the data\n\nContext: Previous conversation about metrics',
        })
      );
    });

    it('should throw NotFoundError when group does not exist', async () => {
      groupRepository.getGroup.mockResolvedValue(null);

      await expect(
        service.escalate({
          parentRunId: 'run_parent12345',
          scope: { orgId: 'org_test', userId: 'user_test', projectId: null },
          sessionKey: 's_test',
          groupId: 'grp_nonexistent',
          goal: 'test',
        })
      ).rejects.toThrow(/not found/i);
    });

    it('should throw ToolError when group has no members', async () => {
      groupRepository.listMembers.mockResolvedValue([]);

      await expect(
        service.escalate({
          parentRunId: 'run_parent12345',
          scope: { orgId: 'org_test', userId: 'user_test', projectId: null },
          sessionKey: 's_test',
          groupId: 'grp_test123456',
          goal: 'test',
        })
      ).rejects.toThrow(/no members/i);
    });

    it('should resume parent run even when child run fails', async () => {
      runRepository.getRunById.mockResolvedValue(
        createMockRunRecord({
          status: 'failed',
          error: { code: 'AGENT_ERROR', message: 'Something went wrong' },
        })
      );

      const result = await service.escalate({
        parentRunId: 'run_parent12345',
        scope: { orgId: 'org_test', userId: 'user_test', projectId: null },
        sessionKey: 's_test',
        groupId: 'grp_test123456',
        goal: 'test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Something went wrong');
      expect(runRepository.setRunResumed).toHaveBeenCalledWith('run_parent12345');
    });

    it('should resume parent run when child run is cancelled', async () => {
      runRepository.getRunById.mockResolvedValue(
        createMockRunRecord({ status: 'cancelled' })
      );

      const result = await service.escalate({
        parentRunId: 'run_parent12345',
        scope: { orgId: 'org_test', userId: 'user_test', projectId: null },
        sessionKey: 's_test',
        groupId: 'grp_test123456',
        goal: 'test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('cancelled');
      expect(runRepository.setRunResumed).toHaveBeenCalledWith('run_parent12345');
    });

    it('should resume parent run on timeout', async () => {
      // getRunById always returns a running run (never completes)
      runRepository.getRunById.mockResolvedValue(
        createMockRunRecord({ status: 'running' })
      );

      await expect(
        service.escalate({
          parentRunId: 'run_parent12345',
          scope: { orgId: 'org_test', userId: 'user_test', projectId: null },
          sessionKey: 's_test',
          groupId: 'grp_test123456',
          goal: 'test',
        })
      ).rejects.toThrow(/did not complete/i);

      expect(runRepository.setRunResumed).toHaveBeenCalledWith('run_parent12345');
    });

    it('should auto-select a group when groupId is omitted', async () => {
      runRepository.getRunById.mockResolvedValue(
        createMockRunRecord({
          status: 'completed',
          result: { output: 'auto-selected result' },
        })
      );

      const result = await service.escalate({
        parentRunId: 'run_parent12345',
        scope: { orgId: 'org_test', userId: 'user_test', projectId: null },
        sessionKey: 's_test',
        goal: 'Analyze the data',
      });

      expect(groupRepository.listGroups).toHaveBeenCalledWith(undefined);
      expect(groupRepository.getGroup).toHaveBeenCalledWith('grp_test123456');
      expect(result.success).toBe(true);
      expect(result.result).toBe('auto-selected result');
    });

    it('should throw ToolError when no groups available for auto-selection', async () => {
      groupRepository.listGroups.mockResolvedValue([]);

      await expect(
        service.escalate({
          parentRunId: 'run_parent12345',
          scope: { orgId: 'org_test', userId: 'user_test', projectId: null },
          sessionKey: 's_test',
          goal: 'test',
        })
      ).rejects.toThrow(/no available groups/i);
    });

    it('should pass projectId to listGroups when scope has projectId', async () => {
      runRepository.getRunById.mockResolvedValue(
        createMockRunRecord({
          status: 'completed',
          result: { output: 'done' },
        })
      );

      await service.escalate({
        parentRunId: 'run_parent12345',
        scope: { orgId: 'org_test', userId: 'user_test', projectId: 'proj_abc' },
        sessionKey: 's_test',
        goal: 'test',
      });

      expect(groupRepository.listGroups).toHaveBeenCalledWith('proj_abc');
    });

    it('should pass explicit delegatedPermissions to child run', async () => {
      runRepository.getRunById.mockResolvedValue(
        createMockRunRecord({
          status: 'completed',
          result: { output: 'done' },
        })
      );

      const dp = { allowed_tools: ['read_file'], denied_tools: ['exec_command'] };

      await service.escalate({
        parentRunId: 'run_parent12345',
        scope: { orgId: 'org_test', userId: 'user_test', projectId: null },
        sessionKey: 's_test',
        groupId: 'grp_test123456',
        goal: 'test',
        delegatedPermissions: dp,
      });

      expect(runRepository.createRun).toHaveBeenCalledWith(
        expect.objectContaining({
          delegatedPermissions: dp,
        })
      );
    });

    it('should inherit delegatedPermissions from parent run when not explicitly provided', async () => {
      const parentDp = { allowed_tools: ['memory_search'], denied_tools: [] };
      // First call: getRunById for parent run (to read delegated permissions)
      // Subsequent calls: getRunById for child run (polling)
      runRepository.getRunById
        .mockResolvedValueOnce(
          createMockRunRecord({
            id: 'run_parent12345',
            delegatedPermissions: parentDp,
          })
        )
        .mockResolvedValue(
          createMockRunRecord({
            status: 'completed',
            result: { output: 'done' },
          })
        );

      await service.escalate({
        parentRunId: 'run_parent12345',
        scope: { orgId: 'org_test', userId: 'user_test', projectId: null },
        sessionKey: 's_test',
        groupId: 'grp_test123456',
        goal: 'test',
      });

      expect(runRepository.createRun).toHaveBeenCalledWith(
        expect.objectContaining({
          delegatedPermissions: parentDp,
        })
      );
    });
  });

  describe('extractRunResult', () => {
    it('should extract output from completed run', () => {
      const run = createMockRunRecord({
        status: 'completed',
        result: { output: 'The answer is 42' },
      });

      const result = service.extractRunResult(run);

      expect(result.success).toBe(true);
      expect(result.result).toBe('The answer is 42');
    });

    it('should extract error from failed run', () => {
      const run = createMockRunRecord({
        status: 'failed',
        error: { code: 'ERR', message: 'boom' },
      });

      const result = service.extractRunResult(run);

      expect(result.success).toBe(false);
      expect(result.error).toContain('boom');
    });

    it('should handle cancelled run', () => {
      const run = createMockRunRecord({ status: 'cancelled' });

      const result = service.extractRunResult(run);

      expect(result.success).toBe(false);
      expect(result.error).toContain('cancelled');
    });

    it('should handle completed run with no output', () => {
      const run = createMockRunRecord({
        status: 'completed',
        result: {},
      });

      const result = service.extractRunResult(run);

      expect(result.success).toBe(true);
      expect(result.result).toContain('no output');
    });
  });
});
