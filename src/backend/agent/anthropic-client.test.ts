/**
 * Anthropic Client tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AnthropicClient } from './anthropic-client.js';
import { LLMError } from '../../utils/errors.js';
import type { Message, ToolDefinition } from '../../types/agent.js';

const MOCK_API_KEY = 'test-anthropic-key';

function mockFetchResponse(
  body: Record<string, unknown>,
  status = 200
): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  }) as typeof globalThis.fetch;
}

function getFetchBody(): Record<string, unknown> {
  return getFetchBodyAt(0);
}

function getFetchBodyAt(index: number): Record<string, unknown> {
  const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
  const calls = mockFn.mock.calls as Array<[string, { body: string }]>;
  return JSON.parse(calls[index]![1].body) as Record<string, unknown>;
}

function createSSEStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe('AnthropicClient', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalEnv;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  describe('constructor', () => {
    it('should use config apiKey', () => {
      expect(
        () => new AnthropicClient({ provider: 'anthropic', model: 'claude-3', apiKey: MOCK_API_KEY })
      ).not.toThrow();
    });

    it('should fall back to env var', () => {
      process.env.ANTHROPIC_API_KEY = 'env-key';
      expect(
        () => new AnthropicClient({ provider: 'anthropic', model: 'claude-3' })
      ).not.toThrow();
    });

    it('should throw if no API key', () => {
      delete process.env.ANTHROPIC_API_KEY;
      expect(
        () => new AnthropicClient({ provider: 'anthropic', model: 'claude-3' })
      ).toThrow(LLMError);
    });
  });

  describe('chat', () => {
    let client: AnthropicClient;

    beforeEach(() => {
      client = new AnthropicClient({
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        apiKey: MOCK_API_KEY,
        baseUrl: 'https://test.anthropic.com',
      });
    });

    it('should send correct request and parse text response', async () => {
      const mockResponse = {
        content: [{ type: 'text', text: 'Hello world' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      };
      globalThis.fetch = mockFetchResponse(mockResponse);

      const messages: Message[] = [{ role: 'user', content: 'Hi' }];
      const result = await client.chat(messages);

      expect(result.content).toBe('Hello world');
      expect(result.toolCalls).toBeUndefined();
      expect(result.usage).toEqual({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://test.anthropic.com/v1/messages',
        expect.objectContaining({
          method: 'POST',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          headers: expect.objectContaining({
            'x-api-key': MOCK_API_KEY,
            'anthropic-version': '2023-06-01',
          }),
        })
      );
    });

    it('should extract system messages', async () => {
      const mockResponse = {
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      };
      globalThis.fetch = mockFetchResponse(mockResponse);

      const messages: Message[] = [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hi' },
      ];
      await client.chat(messages);

      const body = getFetchBody();
      expect(body.system).toBe('You are helpful');
      const msgs = body.messages as Array<Record<string, unknown>>;
      expect(msgs.every((m) => m.role !== 'system')).toBe(true);
    });

    it('should remap non-Anthropic tool IDs and keep tool_use/tool_result aligned', async () => {
      const mockResponse = {
        content: [{ type: 'text', text: 'Done' }],
        usage: { input_tokens: 20, output_tokens: 10 },
      };
      globalThis.fetch = mockFetchResponse(mockResponse);

      const messages: Message[] = [
        { role: 'user', content: 'Do something' },
        {
          role: 'assistant',
          content: 'Calling tool',
          toolCalls: [{ id: 'call_function_abc_1', name: 'read_file', parameters: { path: 'a.md' } }],
        },
        { role: 'tool', content: '{"result": "ok"}', toolCallId: 'call_function_abc_1' },
      ];
      await client.chat(messages);

      const body = getFetchBody();
      const msgs = body.messages as Array<Record<string, unknown>>;
      const assistantMsg = msgs[1]!;
      const assistantBlocks = assistantMsg.content as Array<Record<string, unknown>>;
      const toolUseBlock = assistantBlocks.find((block) => block.type === 'tool_use');
      expect(toolUseBlock).toBeDefined();
      const mappedToolUseId = toolUseBlock?.id as string;
      expect(mappedToolUseId.startsWith('toolu_')).toBe(true);

      const toolMsg = msgs[2]!;
      expect(toolMsg.role).toBe('user');
      const toolContent = toolMsg.content as Array<Record<string, unknown>>;
      expect(toolContent[0]!.type).toBe('tool_result');
      expect(toolContent[0]!.tool_use_id).toBe(mappedToolUseId);
    });

    it('should merge consecutive tool messages', async () => {
      const mockResponse = {
        content: [{ type: 'text', text: 'Done' }],
        usage: { input_tokens: 20, output_tokens: 10 },
      };
      globalThis.fetch = mockFetchResponse(mockResponse);

      const messages: Message[] = [
        { role: 'user', content: 'Do something' },
        {
          role: 'assistant',
          content: 'Calling tools',
          toolCalls: [
            { id: 'tc_1', name: 'read_file', parameters: { path: 'a.md' } },
            { id: 'tc_2', name: 'grep_files', parameters: { pattern: 'foo' } },
          ],
        },
        { role: 'tool', content: 'result1', toolCallId: 'tc_1' },
        { role: 'tool', content: 'result2', toolCallId: 'tc_2' },
      ];
      await client.chat(messages);

      const body = getFetchBody();
      const msgs = body.messages as Array<Record<string, unknown>>;
      expect(msgs).toHaveLength(3);
      expect(msgs[2]!.content as unknown[]).toHaveLength(2);
    });

    it('should assign unique tool_use ids for repeated raw tool call ids across turns', async () => {
      const mockResponse = {
        content: [{ type: 'text', text: 'Done' }],
        usage: { input_tokens: 20, output_tokens: 10 },
      };
      globalThis.fetch = mockFetchResponse(mockResponse);

      const messages: Message[] = [
        { role: 'user', content: 'Do something' },
        {
          role: 'assistant',
          content: 'first call',
          toolCalls: [{ id: 'call_function_dup_2', name: 'read_file', parameters: { path: 'a.md' } }],
        },
        { role: 'tool', content: 'result1', toolCallId: 'call_function_dup_2' },
        {
          role: 'assistant',
          content: 'second call',
          toolCalls: [{ id: 'call_function_dup_2', name: 'read_file', parameters: { path: 'b.md' } }],
        },
        { role: 'tool', content: 'result2', toolCallId: 'call_function_dup_2' },
      ];
      await client.chat(messages);

      const body = getFetchBody();
      const msgs = body.messages as Array<Record<string, unknown>>;

      const firstAssistantBlocks = msgs[1]!.content as Array<Record<string, unknown>>;
      const secondAssistantBlocks = msgs[3]!.content as Array<Record<string, unknown>>;
      const firstToolUseId = firstAssistantBlocks.find((block) => block.type === 'tool_use')!.id as string;
      const secondToolUseId = secondAssistantBlocks.find((block) => block.type === 'tool_use')!.id as string;
      expect(firstToolUseId).not.toBe(secondToolUseId);

      const firstToolResult = (msgs[2]!.content as Array<Record<string, unknown>>)[0]!;
      const secondToolResult = (msgs[4]!.content as Array<Record<string, unknown>>)[0]!;
      expect(firstToolResult.tool_use_id).toBe(firstToolUseId);
      expect(secondToolResult.tool_use_id).toBe(secondToolUseId);
    });

    it('should drop orphan tool messages without matching assistant tool_use', async () => {
      const mockResponse = {
        content: [{ type: 'text', text: 'Done' }],
        usage: { input_tokens: 20, output_tokens: 10 },
      };
      globalThis.fetch = mockFetchResponse(mockResponse);

      const messages: Message[] = [
        { role: 'user', content: 'Do something' },
        { role: 'tool', content: 'orphan-result', toolCallId: 'tc_orphan' },
      ];
      await client.chat(messages);

      const body = getFetchBody();
      const msgs = body.messages as Array<Record<string, unknown>>;
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.role).toBe('user');
    });

    it('should ensure first message is user role', async () => {
      const mockResponse = {
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      };
      globalThis.fetch = mockFetchResponse(mockResponse);

      const messages: Message[] = [
        { role: 'assistant', content: 'I start first' },
        { role: 'user', content: 'Ok' },
      ];
      await client.chat(messages);

      const body = getFetchBody();
      const msgs = body.messages as Array<Record<string, unknown>>;
      expect(msgs[0]!.role).toBe('user');
    });

    it('should map tools to Anthropic format', async () => {
      const mockResponse = {
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      };
      globalThis.fetch = mockFetchResponse(mockResponse);

      const tools: ToolDefinition[] = [
        { name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } },
      ];
      await client.chat([{ role: 'user', content: 'weather?' }], tools);

      const body = getFetchBody();
      const tools_ = body.tools as Array<Record<string, unknown>>;
      expect(tools_[0]).toEqual({
        name: 'get_weather',
        description: 'Get weather',
        input_schema: { type: 'object' },
      });
    });

    it('should parse tool_use response', async () => {
      const mockResponse = {
        content: [
          { type: 'text', text: 'Let me check' },
          { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Beijing' } },
        ],
        usage: { input_tokens: 15, output_tokens: 10 },
      };
      globalThis.fetch = mockFetchResponse(mockResponse);

      const result = await client.chat([{ role: 'user', content: 'weather?' }]);

      expect(result.content).toBe('Let me check');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0]).toEqual({
        id: 'tu_1',
        name: 'get_weather',
        parameters: { city: 'Beijing' },
      });
    });

    it('should handle API error', async () => {
      globalThis.fetch = mockFetchResponse({ error: 'unauthorized' }, 401);

      await expect(
        client.chat([{ role: 'user', content: 'Hi' }])
      ).rejects.toThrow(LLMError);
    });

    it('should retry once with stripped tool history on tool id pairing 400', async () => {
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          text: () => Promise.resolve(
            JSON.stringify({
              type: 'error',
              error: {
                type: 'invalid_request_error',
                message: "invalid params, tool result's tool id(call_function_abc_2) not found (2013)",
              },
            })
          ),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            content: [{ type: 'text', text: 'Recovered response' }],
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
        }) as typeof globalThis.fetch;

      const messages: Message[] = [
        { role: 'user', content: 'question' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_function_abc_2', name: 'read_file', parameters: { path: 'a.md' } }],
        },
        { role: 'tool', content: '{"ok":true}', toolCallId: 'call_function_abc_2' },
      ];

      const result = await client.chat(messages);
      expect(result.content).toBe('Recovered response');
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);

      const secondBody = getFetchBodyAt(1);
      const secondMessages = secondBody.messages as Array<Record<string, unknown>>;
      const hasToolResult = secondMessages.some(
        (msg) => Array.isArray(msg.content)
          && (msg.content as Array<Record<string, unknown>>).some((block) => block.type === 'tool_result')
      );
      expect(hasToolResult).toBe(false);
    });

    it('should retry once on generic 400 when request contains tool history', async () => {
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          text: () => Promise.resolve(
            JSON.stringify({
              type: 'error',
              error: {
                type: 'invalid_request_error',
                message: 'invalid params, malformed request payload',
              },
            })
          ),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            content: [{ type: 'text', text: 'Recovered generic 400' }],
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
        }) as typeof globalThis.fetch;

      const messages: Message[] = [
        { role: 'user', content: 'question' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_function_abc_3', name: 'read_file', parameters: { path: 'a.md' } }],
        },
        { role: 'tool', content: '{"ok":true}', toolCallId: 'call_function_abc_3' },
      ];

      const result = await client.chat(messages);
      expect(result.content).toBe('Recovered generic 400');
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('should handle empty content', async () => {
      globalThis.fetch = mockFetchResponse({ content: [] });

      await expect(
        client.chat([{ role: 'user', content: 'Hi' }])
      ).rejects.toThrow(LLMError);
    });
  });

  describe('chatStream', () => {
    let client: AnthropicClient;

    beforeEach(() => {
      client = new AnthropicClient({
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        apiKey: MOCK_API_KEY,
        baseUrl: 'https://test.anthropic.com',
      });
    });

    it('should retry stream request once with stripped tool history on tool id pairing 400', async () => {
      const sseData = [
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Recovered stream"}}\n',
        'data: {"type":"message_stop"}\n',
      ];

      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          text: () => Promise.resolve(
            JSON.stringify({
              type: 'error',
              error: {
                type: 'invalid_request_error',
                message: "invalid params, tool result's tool id(call_function_abc_2) not found (2013)",
              },
            })
          ),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          body: createSSEStream(sseData),
        }) as typeof globalThis.fetch;

      const messages: Message[] = [
        { role: 'user', content: 'question' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_function_abc_2', name: 'read_file', parameters: { path: 'a.md' } }],
        },
        { role: 'tool', content: '{"ok":true}', toolCallId: 'call_function_abc_2' },
      ];

      const deltas: string[] = [];
      for await (const chunk of client.chatStream!(messages)) {
        if (chunk.delta) {
          deltas.push(chunk.delta);
        }
      }

      expect(deltas.join('')).toContain('Recovered stream');
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('should retry stream request on generic 400 when request contains tool history', async () => {
      const sseData = [
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Recovered generic stream"}}\n',
        'data: {"type":"message_stop"}\n',
      ];

      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          text: () => Promise.resolve(
            JSON.stringify({
              type: 'error',
              error: {
                type: 'invalid_request_error',
                message: 'invalid params, malformed request payload',
              },
            })
          ),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          body: createSSEStream(sseData),
        }) as typeof globalThis.fetch;

      const messages: Message[] = [
        { role: 'user', content: 'question' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_function_abc_3', name: 'read_file', parameters: { path: 'a.md' } }],
        },
        { role: 'tool', content: '{"ok":true}', toolCallId: 'call_function_abc_3' },
      ];

      const deltas: string[] = [];
      for await (const chunk of client.chatStream!(messages)) {
        if (chunk.delta) {
          deltas.push(chunk.delta);
        }
      }

      expect(deltas.join('')).toContain('Recovered generic stream');
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });
  });
});
