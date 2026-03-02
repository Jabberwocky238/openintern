import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Event } from '@openintern/types/events.js';
import { EventSchema } from '@openintern/types/events.js';
import type { LLMResponse, Message } from '@openintern/types/agent.js';
import { createLLMClient } from '../agent/llm-client.js';
import { SingleAgentRunner, type RunnerContext } from './agent-runner.js';
import { RunSuspendedError } from './tool-scheduler.js';

vi.mock('../agent/llm-client.js', () => ({
  createLLMClient: vi.fn(),
}));

const mockedCreateLLMClient = vi.mocked(createLLMClient);

const runnerContext: RunnerContext = {
  runId: 'run_test123456',
  sessionKey: 's_test',
  scope: {
    orgId: 'org_test',
    userId: 'user_test',
    projectId: null,
  },
  agentId: 'main',
};

function usage(): LLMResponse['usage'] {
  return {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
  };
}

function nthIndexOf(items: string[], target: string, n: number): number {
  let count = 0;
  for (let i = 0; i < items.length; i++) {
    if (items[i] === target) {
      count++;
      if (count === n) {
        return i;
      }
    }
  }
  return -1;
}

async function collectRun(
  runner: SingleAgentRunner,
  input: string,
  ctx: RunnerContext,
  timeline: string[]
): Promise<{
  events: Event[];
  result: Awaited<ReturnType<SingleAgentRunner['run']> extends AsyncGenerator<Event, infer R, void> ? R : never>;
}> {
  const iterator = runner.run(input, ctx);
  const events: Event[] = [];

  while (true) {
    const next = await iterator.next();
    if (next.done) {
      return {
        events,
        result: next.value,
      };
    }
    timeline.push(`event:${next.value.type}`);
    const parsed = EventSchema.safeParse(next.value);
    expect(parsed.success).toBe(true);
    events.push(next.value);
  }
}

function assertEventMetadata(events: Event[]): void {
  expect(events.length).toBeGreaterThan(0);
  const parentSpans = new Set(events.map((event) => event.parent_span_id));

  for (const event of events) {
    expect(event.agent_id).toBe('main');
    expect(event.span_id).toMatch(/^sp_[A-Za-z0-9]+$/);
    expect(event.step_id).toMatch(/^step_[0-9]{4}$/);
    expect(event.parent_span_id).toMatch(/^sp_[A-Za-z0-9]+$/);
  }

  // all events in one run should share the same root parent span
  expect(parentSpans.size).toBe(1);
}

describe('SingleAgentRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves step order without tool calls and saves checkpoint before step.completed', async () => {
    const timeline: string[] = [];
    const memoryService = {
      memory_search: vi.fn(async () => {
        timeline.push('memory_search');
        return [];
      }),
      memory_search_pa: vi.fn(async () => {
        timeline.push('memory_search');
        return [];
      }),
      memory_search_tiered: vi.fn(async () => []),
    };
    const checkpointService = {
      save: vi.fn(async () => {
        timeline.push('checkpoint.saved');
      }),
    };
    const toolRouter = {
      listTools: vi.fn(() => []),
      listSkills: vi.fn(() => []),
      callTool: vi.fn(async () => ({
        success: true,
        result: {},
        duration: 1,
      })),
    };
    const chat = vi.fn(async () => {
      timeline.push('model');
      return {
        content: 'final answer',
        usage: usage(),
      };
    });
    mockedCreateLLMClient.mockReturnValue({ chat });

    const runner = new SingleAgentRunner({
      maxSteps: 3,
      modelConfig: { provider: 'mock', model: 'mock-model' },
      checkpointService: checkpointService as never,
      memoryService: memoryService as never,
      toolRouter: toolRouter as never,
    });

    const { events, result } = await collectRun(
      runner,
      'hello',
      runnerContext,
      timeline
    );

    expect(result.status).toBe('completed');
    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'step.started',
      'llm.called',
      'step.completed',
      'run.completed',
    ]);

    const stepCompleted = events.find(
      (event) => event.type === 'step.completed'
    );
    expect(stepCompleted?.payload.resultType).toBe('final_answer');

    expect(nthIndexOf(timeline, 'event:step.started', 1)).toBeLessThan(
      nthIndexOf(timeline, 'memory_search', 1)
    );
    expect(nthIndexOf(timeline, 'memory_search', 1)).toBeLessThan(
      nthIndexOf(timeline, 'model', 1)
    );
    expect(nthIndexOf(timeline, 'model', 1)).toBeLessThan(
      nthIndexOf(timeline, 'checkpoint.saved', 1)
    );
    expect(nthIndexOf(timeline, 'checkpoint.saved', 1)).toBeLessThan(
      nthIndexOf(timeline, 'event:step.completed', 1)
    );

    expect(checkpointService.save).toHaveBeenCalledTimes(1);
    expect(toolRouter.callTool).not.toHaveBeenCalled();
    assertEventMetadata(events);
  });

  it('preserves step order with tool calls across multiple steps', async () => {
    const timeline: string[] = [];
    const memoryService = {
      memory_search: vi.fn(async () => {
        timeline.push('memory_search');
        return [];
      }),
      memory_search_pa: vi.fn(async () => {
        timeline.push('memory_search');
        return [];
      }),
      memory_search_tiered: vi.fn(async () => []),
    };
    const checkpointService = {
      save: vi.fn(async () => {
        timeline.push('checkpoint.saved');
      }),
    };
    const toolRouter = {
      listTools: vi.fn(() => [
        {
          name: 'read_file',
          description: 'read file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ]),
      listSkills: vi.fn(() => []),
      callTool: vi.fn(async () => {
        timeline.push('tool.execute');
        return {
          success: true,
          result: { content: 'ok' },
          duration: 1,
        };
      }),
    };
    const chat = vi
      .fn()
      .mockImplementationOnce(async () => {
        timeline.push('model');
        return {
          content: 'need tool',
          usage: usage(),
          toolCalls: [
            {
              id: 'tc_1',
              name: 'read_file',
              parameters: { path: 'README.md' },
            },
          ],
        };
      })
      .mockImplementationOnce(async () => {
        timeline.push('model');
        return {
          content: 'done',
          usage: usage(),
        };
      });
    mockedCreateLLMClient.mockReturnValue({ chat });

    const runner = new SingleAgentRunner({
      maxSteps: 3,
      modelConfig: { provider: 'mock', model: 'mock-model' },
      checkpointService: checkpointService as never,
      memoryService: memoryService as never,
      toolRouter: toolRouter as never,
    });

    const { events, result } = await collectRun(
      runner,
      'read something',
      runnerContext,
      timeline
    );

    expect(result.status).toBe('completed');
    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'step.started',
      'llm.called',
      'tool.hint',
      'tool.batch.started',
      'tool.called',
      'tool.result',
      'tool.batch.completed',
      'step.completed',
      'step.started',
      'llm.called',
      'step.completed',
      'run.completed',
    ]);

    const stepCompletedEvents = events.filter(
      (event) => event.type === 'step.completed'
    );
    expect(stepCompletedEvents).toHaveLength(2);
    expect(stepCompletedEvents[0]?.payload.resultType).toBe('tool_call');
    expect(stepCompletedEvents[1]?.payload.resultType).toBe('final_answer');
    const toolHint = events.find((event) => event.type === 'tool.hint');
    expect(toolHint).toBeDefined();
    if (toolHint?.type === 'tool.hint') {
      expect(toolHint.payload.hint).toContain('read_file');
      expect(toolHint.payload.tool_count).toBe(1);
    }

    // Step 1: step.started -> memory_search -> model -> tool -> checkpoint.saved -> step.completed
    expect(nthIndexOf(timeline, 'event:step.started', 1)).toBeLessThan(
      nthIndexOf(timeline, 'memory_search', 1)
    );
    expect(nthIndexOf(timeline, 'memory_search', 1)).toBeLessThan(
      nthIndexOf(timeline, 'model', 1)
    );
    expect(nthIndexOf(timeline, 'model', 1)).toBeLessThan(
      nthIndexOf(timeline, 'tool.execute', 1)
    );
    expect(nthIndexOf(timeline, 'tool.execute', 1)).toBeLessThan(
      nthIndexOf(timeline, 'checkpoint.saved', 1)
    );
    expect(nthIndexOf(timeline, 'checkpoint.saved', 1)).toBeLessThan(
      nthIndexOf(timeline, 'event:step.completed', 1)
    );

    // Step 2: step.started -> memory_search -> model -> checkpoint.saved -> step.completed
    expect(nthIndexOf(timeline, 'event:step.started', 2)).toBeLessThan(
      nthIndexOf(timeline, 'memory_search', 2)
    );
    expect(nthIndexOf(timeline, 'memory_search', 2)).toBeLessThan(
      nthIndexOf(timeline, 'model', 2)
    );
    expect(nthIndexOf(timeline, 'model', 2)).toBeLessThan(
      nthIndexOf(timeline, 'checkpoint.saved', 2)
    );
    expect(nthIndexOf(timeline, 'checkpoint.saved', 2)).toBeLessThan(
      nthIndexOf(timeline, 'event:step.completed', 2)
    );

    expect(checkpointService.save).toHaveBeenCalledTimes(2);
    expect(toolRouter.callTool).toHaveBeenCalledTimes(1);
    assertEventMetadata(events);
  });

  it('canonicalizes provider tool call ids so repeated ids across turns stay unique', async () => {
    const memoryService = {
      memory_search: vi.fn(async () => []),
      memory_search_pa: vi.fn(async () => []),
      memory_search_tiered: vi.fn(async () => []),
    };
    const checkpointService = {
      save: vi.fn(async () => undefined),
    };
    const toolRouter = {
      listTools: vi.fn(() => [
        {
          name: 'read_file',
          description: 'read file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ]),
      listSkills: vi.fn(() => []),
      callTool: vi.fn(async () => ({
        success: true,
        result: { content: 'ok' },
        duration: 1,
      })),
    };
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: 'first tool',
        usage: usage(),
        toolCalls: [
          {
            id: 'call_function_dup_2',
            name: 'read_file',
            parameters: { path: 'README.md' },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: 'second tool',
        usage: usage(),
        toolCalls: [
          {
            id: 'call_function_dup_2',
            name: 'read_file',
            parameters: { path: 'package.json' },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: 'done',
        usage: usage(),
      });
    mockedCreateLLMClient.mockReturnValue({ chat });

    const runner = new SingleAgentRunner({
      maxSteps: 4,
      modelConfig: { provider: 'mock', model: 'mock-model' },
      checkpointService: checkpointService as never,
      memoryService: memoryService as never,
      toolRouter: toolRouter as never,
    });

    const { result } = await collectRun(
      runner,
      'read twice',
      runnerContext,
      []
    );

    expect(result.status).toBe('completed');
    expect(toolRouter.callTool).toHaveBeenCalledTimes(2);

    const thirdCallMessages = chat.mock.calls[2]?.[0] as Message[];
    const assistantToolMessages = thirdCallMessages.filter(
      (message) => message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0
    );
    const toolResultMessages = thirdCallMessages.filter((message) => message.role === 'tool');

    expect(assistantToolMessages).toHaveLength(2);
    expect(toolResultMessages).toHaveLength(2);

    const firstId = assistantToolMessages[0]!.toolCalls![0]!.id;
    const secondId = assistantToolMessages[1]!.toolCalls![0]!.id;
    expect(firstId).not.toBe(secondId);
    expect(toolResultMessages[0]!.toolCallId).toBe(firstId);
    expect(toolResultMessages[1]!.toolCallId).toBe(secondId);
  });

  it('forces final synthesis on the last step instead of executing another tool batch', async () => {
    const timeline: string[] = [];
    const memoryService = {
      memory_search: vi.fn(async () => {
        timeline.push('memory_search');
        return [];
      }),
      memory_search_pa: vi.fn(async () => {
        timeline.push('memory_search');
        return [];
      }),
      memory_search_tiered: vi.fn(async () => []),
    };
    const checkpointService = {
      save: vi.fn(async () => {
        timeline.push('checkpoint.saved');
      }),
    };
    const toolRouter = {
      listTools: vi.fn(() => [
        {
          name: 'read_file',
          description: 'read file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ]),
      listSkills: vi.fn(() => []),
      callTool: vi.fn(async () => ({
        success: true,
        result: { content: 'ok' },
        duration: 1,
      })),
    };
    const chat = vi.fn(async () => ({
      content: 'need tool',
      usage: usage(),
      toolCalls: [
        {
          id: 'tc_1',
          name: 'read_file',
          parameters: { path: 'README.md' },
        },
      ],
    }));
    mockedCreateLLMClient.mockReturnValue({ chat });

    const runner = new SingleAgentRunner({
      maxSteps: 1,
      modelConfig: { provider: 'mock', model: 'mock-model' },
      checkpointService: checkpointService as never,
      memoryService: memoryService as never,
      toolRouter: toolRouter as never,
    });

    const { events, result } = await collectRun(
      runner,
      'never final',
      runnerContext,
      timeline
    );

    expect(result.status).toBe('completed');
    expect(result.output).toContain('need tool');
    expect(events.some((event) => event.type === 'run.failed')).toBe(false);
    const warning = events.find(
      (event) => event.type === 'run.warning' && event.payload.code === 'MAX_STEPS_FORCE_FINALIZE'
    );
    expect(warning).toBeDefined();
    expect(toolRouter.callTool).not.toHaveBeenCalled();
    const completed = events.find((event) => event.type === 'run.completed');
    expect(completed).toBeDefined();
    if (completed?.type === 'run.completed') {
      expect(completed.payload.output).toContain('need tool');
    }
    assertEventMetadata(events);
  });

  it('injects skill catalog into system message for model context', async () => {
    const memoryService = {
      memory_search: vi.fn(async () => []),
      memory_search_pa: vi.fn(async () => []),
      memory_search_tiered: vi.fn(async () => []),
    };
    const checkpointService = {
      save: vi.fn(async () => undefined),
    };
    const toolRouter = {
      listTools: vi.fn(() => []),
      listSkills: vi.fn(() => [
        {
          id: 'skill_fs',
          name: 'File Skill',
          description: 'File operations',
          tools: [{ name: 'read_file', description: '', parameters: {} }],
          risk_level: 'low',
          provider: 'builtin',
          health_status: 'healthy',
          allow_implicit_invocation: false,
        },
      ]),
      callTool: vi.fn(async () => ({
        success: true,
        result: {},
        duration: 1,
      })),
    };
    const chat = vi.fn(async () => ({
      content: 'done',
      usage: usage(),
    }));
    mockedCreateLLMClient.mockReturnValue({ chat });

    const runner = new SingleAgentRunner({
      maxSteps: 2,
      modelConfig: { provider: 'mock', model: 'mock-model' },
      checkpointService: checkpointService as never,
      memoryService: memoryService as never,
      toolRouter: toolRouter as never,
    });

    const timeline: string[] = [];
    await collectRun(runner, 'hello', runnerContext, timeline);

    expect(chat).toHaveBeenCalled();
    const firstCall = chat.mock.calls.at(0);
    const firstCallArgs = (firstCall as unknown[] | undefined) ?? [];
    const firstCallMessages = (firstCallArgs[0] as Array<{ role: string; content: string }> | undefined) ?? [];
    expect(firstCallMessages?.[0]?.role).toBe('system');
    expect(firstCallMessages?.[0]?.content).toContain('Skill catalog');
    expect(firstCallMessages?.[0]?.content).toContain('skill_fs');
    expect(firstCallMessages?.[0]?.content).toContain('read_file');
  });

  it('forces final synthesis when lookup-only loop persists near step limit', async () => {
    const memoryService = {
      memory_search: vi.fn(async () => []),
      memory_search_pa: vi.fn(async () => []),
      memory_search_tiered: vi.fn(async () => []),
    };
    const checkpointService = {
      save: vi.fn(async () => undefined),
    };
    const toolRouter = {
      listTools: vi.fn(() => [
        {
          name: 'grep_files',
          description: 'search text',
          parameters: {
            type: 'object',
            properties: { pattern: { type: 'string' } },
            required: ['pattern'],
          },
        },
      ]),
      listSkills: vi.fn(() => []),
      callTool: vi.fn(async () => ({
        success: true,
        result: { matches: [] },
        duration: 1,
      })),
    };
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: 'search pass 1',
        usage: usage(),
        toolCalls: [{ id: 'tc_1', name: 'grep_files', parameters: { pattern: 'a' } }],
      })
      .mockResolvedValueOnce({
        content: 'search pass 2',
        usage: usage(),
        toolCalls: [{ id: 'tc_2', name: 'grep_files', parameters: { pattern: 'b' } }],
      })
      .mockResolvedValueOnce({
        content: 'search pass 3',
        usage: usage(),
        toolCalls: [{ id: 'tc_3', name: 'grep_files', parameters: { pattern: 'c' } }],
      })
      .mockResolvedValueOnce({
        content: 'final synthesis with data',
        usage: usage(),
      });
    mockedCreateLLMClient.mockReturnValue({ chat });

    const runner = new SingleAgentRunner({
      maxSteps: 4,
      modelConfig: { provider: 'mock', model: 'mock-model' },
      checkpointService: checkpointService as never,
      memoryService: memoryService as never,
      toolRouter: toolRouter as never,
    });

    const { events, result } = await collectRun(runner, 'summarize papers', runnerContext, []);

    expect(result.status).toBe('completed');
    expect(result.output).toContain('final synthesis');
    expect(toolRouter.callTool).toHaveBeenCalledTimes(2);
    const warning = events.find(
      (event) => event.type === 'run.warning'
        && event.payload.code === 'LOOKUP_LOOP_FORCE_FINALIZE'
    );
    expect(warning).toBeDefined();
    expect(events.some((event) => event.type === 'run.failed')).toBe(false);
  });

  it('emits run.failed when model throws instead of hanging silently', async () => {
    const timeline: string[] = [];
    const memoryService = {
      memory_search: vi.fn(async () => {
        timeline.push('memory_search');
        return [];
      }),
      memory_search_pa: vi.fn(async () => {
        timeline.push('memory_search');
        return [];
      }),
      memory_search_tiered: vi.fn(async () => []),
    };
    const checkpointService = {
      save: vi.fn(async () => {
        timeline.push('checkpoint.saved');
      }),
    };
    const toolRouter = {
      listTools: vi.fn(() => []),
      listSkills: vi.fn(() => []),
      callTool: vi.fn(async () => ({
        success: true,
        result: {},
        duration: 1,
      })),
    };
    const chat = vi.fn(async () => {
      throw new Error('model unavailable');
    });
    mockedCreateLLMClient.mockReturnValue({ chat });

    const runner = new SingleAgentRunner({
      maxSteps: 3,
      modelConfig: { provider: 'mock', model: 'mock-model' },
      checkpointService: checkpointService as never,
      memoryService: memoryService as never,
      toolRouter: toolRouter as never,
    });

    const { events, result } = await collectRun(
      runner,
      'fail fast',
      runnerContext,
      timeline
    );

    expect(result.status).toBe('failed');
    expect(result.error).toContain('model unavailable');
    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'step.started',
      'run.failed',
    ]);
    expect(checkpointService.save).not.toHaveBeenCalled();
    assertEventMetadata(events);
  });

  it('strips think blocks from final output', async () => {
    const memoryService = {
      memory_search: vi.fn(async () => []),
      memory_search_pa: vi.fn(async () => []),
      memory_search_tiered: vi.fn(async () => []),
    };
    const checkpointService = {
      save: vi.fn(async () => undefined),
    };
    const toolRouter = {
      listTools: vi.fn(() => []),
      listSkills: vi.fn(() => []),
      callTool: vi.fn(async () => ({
        success: true,
        result: {},
        duration: 1,
      })),
    };
    const chat = vi.fn(async () => ({
      content: '<think>internal plan</think>\nfinal answer',
      usage: usage(),
    }));
    mockedCreateLLMClient.mockReturnValue({ chat });

    const runner = new SingleAgentRunner({
      maxSteps: 2,
      modelConfig: { provider: 'mock', model: 'mock-model' },
      checkpointService: checkpointService as never,
      memoryService: memoryService as never,
      toolRouter: toolRouter as never,
    });

    const { events, result } = await collectRun(runner, 'sanitize output', runnerContext, []);

    expect(result.status).toBe('completed');
    expect(result.output).toBe('final answer');
    const completed = events.find((event) => event.type === 'run.completed');
    if (completed?.type === 'run.completed') {
      expect(completed.payload.output).toBe('final answer');
    }
  });

  it('streams llm.token events before llm.called when streaming is available', async () => {
    const memoryService = {
      memory_search: vi.fn(async () => []),
      memory_search_pa: vi.fn(async () => []),
      memory_search_tiered: vi.fn(async () => []),
    };
    const checkpointService = {
      save: vi.fn(async () => undefined),
    };
    const toolRouter = {
      listTools: vi.fn(() => []),
      listSkills: vi.fn(() => []),
      callTool: vi.fn(async () => ({
        success: true,
        result: {},
        duration: 1,
      })),
    };
    const chat = vi.fn(async () => ({
      content: 'fallback',
      usage: usage(),
    }));
    const chatStream = vi.fn(async function* () {
      yield { delta: 'hello', done: false };
      yield { delta: ' world', done: false };
      yield { delta: '', done: true, usage: usage() };
    });
    mockedCreateLLMClient.mockReturnValue({ chat, chatStream });

    const runner = new SingleAgentRunner({
      maxSteps: 2,
      modelConfig: { provider: 'mock', model: 'mock-model' },
      checkpointService: checkpointService as never,
      memoryService: memoryService as never,
      toolRouter: toolRouter as never,
    });

    const { events, result } = await collectRun(runner, 'stream please', runnerContext, []);

    expect(result.status).toBe('completed');
    expect(chat).not.toHaveBeenCalled();
    const tokenEvents = events.filter((event) => event.type === 'llm.token');
    expect(tokenEvents.length).toBe(2);
    expect(
      tokenEvents.map((event) => (event.payload as { token: string }).token).join('')
    ).toBe('hello world');
    expect(events.findIndex((event) => event.type === 'llm.token')).toBeLessThan(
      events.findIndex((event) => event.type === 'llm.called')
    );
  });

  it('passes incremental checkpoint window when resuming from existing messages', async () => {
    const memoryService = {
      memory_search: vi.fn(async () => []),
      memory_search_pa: vi.fn(async () => []),
      memory_search_tiered: vi.fn(async () => []),
    };
    const checkpointService = {
      save: vi.fn(async () => undefined),
    };
    const toolRouter = {
      listTools: vi.fn(() => [
        {
          name: 'read_file',
          description: 'read file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ]),
      listSkills: vi.fn(() => []),
      callTool: vi.fn(async () => ({
        success: true,
        result: { content: 'ok' },
        duration: 1,
      })),
    };
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: 'need tool',
        usage: usage(),
        toolCalls: [
          {
            id: 'tc_resume',
            name: 'read_file',
            parameters: { path: 'README.md' },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: 'done',
        usage: usage(),
      });
    mockedCreateLLMClient.mockReturnValue({ chat });

    const runner = new SingleAgentRunner({
      maxSteps: 3,
      modelConfig: { provider: 'mock', model: 'mock-model' },
      checkpointService: checkpointService as never,
      memoryService: memoryService as never,
      toolRouter: toolRouter as never,
    });

    const resumedMessages = [
      { role: 'user' as const, content: 'q1' },
      { role: 'assistant' as const, content: 'a1' },
      { role: 'tool' as const, content: '{"old":true}', toolCallId: 'tc_old' },
    ];

    await collectRun(
      runner,
      'ignored after resume',
      {
        ...runnerContext,
        resumeFrom: {
          stepNumber: 1,
          messages: resumedMessages,
          workingState: { plan: 'resume' },
        },
      },
      []
    );

    expect(checkpointService.save).toHaveBeenCalled();
    const saveCalls = (checkpointService.save as { mock: { calls: Array<unknown[]> } }).mock.calls;
    const incrementalCall = saveCalls.find((call) => call[4] === 3);
    expect(incrementalCall).toBeDefined();
    expect(incrementalCall?.[2]).toBe('step_0002');
    const nextCall = saveCalls.find((call) => call[2] === 'step_0003');
    expect(nextCall?.[4]).toBe(5);
  });

  it('injects synthetic tool results for orphaned tool calls on resume', async () => {
    const memoryService = {
      memory_search: vi.fn(async () => []),
      memory_search_pa: vi.fn(async () => []),
      memory_search_tiered: vi.fn(async () => []),
    };
    const checkpointService = {
      save: vi.fn(async () => undefined),
    };
    const toolRouter = {
      listTools: vi.fn(() => [
        {
          name: 'read_file',
          description: 'read file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ]),
      listSkills: vi.fn(() => []),
      callTool: vi.fn(async () => ({
        success: true,
        result: { content: 'ok' },
        duration: 1,
      })),
    };
    const chat = vi.fn(async () => ({
      content: 'done',
      usage: usage(),
    }));
    mockedCreateLLMClient.mockReturnValue({ chat });

    const runner = new SingleAgentRunner({
      maxSteps: 3,
      modelConfig: { provider: 'mock', model: 'mock-model' },
      checkpointService: checkpointService as never,
      memoryService: memoryService as never,
      toolRouter: toolRouter as never,
    });

    const orphanedToolCallId = 'tc_orphan_1';
    const resumedMessages = [
      { role: 'user' as const, content: 'read README' },
      {
        role: 'assistant' as const,
        content: 'calling tool',
        toolCalls: [
          {
            id: orphanedToolCallId,
            name: 'read_file',
            parameters: { path: 'README.md' },
          },
        ],
      },
    ];

    const { events, result } = await collectRun(
      runner,
      'ignored after resume',
      {
        ...runnerContext,
        resumeFrom: {
          stepNumber: 1,
          messages: resumedMessages,
          workingState: { plan: 'resume-with-orphan' },
        },
      },
      []
    );

    expect(result.status).toBe('completed');
    const resumedEvent = events.find((event) => event.type === 'run.resumed');
    expect(resumedEvent).toBeDefined();
    if (resumedEvent?.type === 'run.resumed') {
      expect(resumedEvent.payload.orphaned_tool_calls).toBe(1);
    }

    expect(chat).toHaveBeenCalled();
    const firstCall = chat.mock.calls.at(0);
    const firstCallArgs = (firstCall as unknown[] | undefined) ?? [];
    const firstCallMessages = (firstCallArgs[0] as Array<{
      role: string;
      toolCallId?: string;
      content: string;
    }> | undefined) ?? [];
    const synthetic = firstCallMessages.find(
      (message) => message.role === 'tool' && message.toolCallId === orphanedToolCallId
    );
    expect(synthetic).toBeDefined();
    expect(synthetic?.content).toContain('interrupted');
  });

  it('emits run.suspended and returns suspended when scheduler throws RunSuspendedError', async () => {
    const memoryService = {
      memory_search: vi.fn(async () => []),
      memory_search_pa: vi.fn(async () => []),
      memory_search_tiered: vi.fn(async () => []),
    };
    const checkpointService = {
      save: vi.fn(async () => undefined),
    };
    const toolRouter = {
      listTools: vi.fn(() => [
        {
          name: 'dangerous_tool',
          description: 'danger',
          parameters: {
            type: 'object',
            properties: {},
          },
        },
      ]),
      listSkills: vi.fn(() => []),
      callTool: vi.fn(async () => ({
        success: true,
        result: {},
        duration: 1,
      })),
    };
    const toolScheduler = {
      executeBatch: vi.fn(async () => {
        throw new RunSuspendedError(
          'tc_suspend',
          'dangerous_tool',
          { path: '/etc/passwd' },
          'Requires approval'
        );
      }),
    };
    const chat = vi.fn(async () => ({
      content: 'requesting dangerous tool',
      usage: usage(),
      toolCalls: [
        {
          id: 'tc_suspend',
          name: 'dangerous_tool',
          parameters: { path: '/etc/passwd' },
        },
      ],
    }));
    mockedCreateLLMClient.mockReturnValue({ chat });

    const runner = new SingleAgentRunner({
      maxSteps: 2,
      modelConfig: { provider: 'mock', model: 'mock-model' },
      checkpointService: checkpointService as never,
      memoryService: memoryService as never,
      toolRouter: toolRouter as never,
      toolScheduler: toolScheduler as never,
    });

    const { events, result } = await collectRun(runner, 'suspend me', runnerContext, []);

    expect(result.status).toBe('suspended');
    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'step.started',
      'llm.called',
      'tool.hint',
      'run.suspended',
    ]);
    expect(events.some((event) => event.type === 'run.failed')).toBe(false);
    expect(checkpointService.save).toHaveBeenCalledTimes(1);
  });

  it('emits RUN_CANCELLED when abort signal is already cancelled', async () => {
    const memoryService = {
      memory_search: vi.fn(async () => []),
      memory_search_pa: vi.fn(async () => []),
      memory_search_tiered: vi.fn(async () => []),
    };
    const checkpointService = {
      save: vi.fn(async () => undefined),
    };
    const toolRouter = {
      listTools: vi.fn(() => []),
      listSkills: vi.fn(() => []),
      callTool: vi.fn(async () => ({
        success: true,
        result: {},
        duration: 1,
      })),
    };
    const chat = vi.fn(async () => ({
      content: 'should not happen',
      usage: usage(),
    }));
    mockedCreateLLMClient.mockReturnValue({ chat });

    const runner = new SingleAgentRunner({
      maxSteps: 2,
      modelConfig: { provider: 'mock', model: 'mock-model' },
      checkpointService: checkpointService as never,
      memoryService: memoryService as never,
      toolRouter: toolRouter as never,
    });

    const controller = new AbortController();
    controller.abort();
    const { events, result } = await collectRun(
      runner,
      'cancel me',
      {
        ...runnerContext,
        abortSignal: controller.signal,
      },
      []
    );

    expect(result.status).toBe('failed');
    expect(result.error).toContain('cancelled');
    expect(events.map((event) => event.type)).toEqual(['run.started', 'run.failed']);
    const failed = events.find((event) => event.type === 'run.failed');
    expect(failed?.payload.error.code).toBe('RUN_CANCELLED');
    expect(chat).not.toHaveBeenCalled();
  });
});

