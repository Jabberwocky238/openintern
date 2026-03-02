/**
 * OpenAI Client tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OpenAIClient } from './openai-client.js';
import { LLMError } from '../../utils/errors.js';
import type { Message, ToolDefinition } from '../../types/agent.js';

const MOCK_API_KEY = 'test-openai-key';

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
  const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
  const calls = mockFn.mock.calls as Array<[string, { body: string }]>;
  return JSON.parse(calls[0]![1].body) as Record<string, unknown>;
}

describe('OpenAIClient', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.OPENAI_API_KEY;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv !== undefined) {
      process.env.OPENAI_API_KEY = originalEnv;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  describe('constructor', () => {
    it('should use config apiKey', () => {
      expect(
        () => new OpenAIClient({ provider: 'openai', model: 'gpt-4', apiKey: MOCK_API_KEY })
      ).not.toThrow();
    });

    it('should fall back to env var', () => {
      process.env.OPENAI_API_KEY = 'env-key';
      expect(
        () => new OpenAIClient({ provider: 'openai', model: 'gpt-4' })
      ).not.toThrow();
    });

    it('should throw if no API key', () => {
      delete process.env.OPENAI_API_KEY;
      expect(
        () => new OpenAIClient({ provider: 'openai', model: 'gpt-4' })
      ).toThrow(LLMError);
    });
  });

  describe('chat', () => {
    let client: OpenAIClient;

    beforeEach(() => {
      client = new OpenAIClient({
        provider: 'openai',
        model: 'gpt-4',
        apiKey: MOCK_API_KEY,
        baseUrl: 'https://test.openai.com/v1',
      });
    });

    it('should send correct request and parse text response', async () => {
      const mockResponse = {
        choices: [{ message: { content: 'Hello world', tool_calls: undefined } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
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

      // Verify fetch was called with correct URL and headers
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://test.openai.com/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          headers: expect.objectContaining({
            Authorization: `Bearer ${MOCK_API_KEY}`,
          }),
        })
      );
    });

    it('should map tool messages with tool_call_id', async () => {
      const mockResponse = {
        choices: [{ message: { content: 'Done' } }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      };
      globalThis.fetch = mockFetchResponse(mockResponse);

      const messages: Message[] = [
        { role: 'user', content: 'Do something' },
        {
          role: 'assistant',
          content: 'Calling tool',
          toolCalls: [{ id: 'tc_123', name: 'read_file', parameters: { path: 'a.md' } }],
        },
        { role: 'tool', content: '{"result": "ok"}', toolCallId: 'tc_123' },
      ];
      await client.chat(messages);

      const body = getFetchBody();
      expect((body.messages as Array<Record<string, unknown>>)[2]!.tool_call_id).toBe('tc_123');
    });

    it('should map tools to OpenAI format', async () => {
      const mockResponse = {
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
      globalThis.fetch = mockFetchResponse(mockResponse);

      const tools: ToolDefinition[] = [
        { name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } },
      ];
      await client.chat([{ role: 'user', content: 'weather?' }], tools);

      const body = getFetchBody();
      expect((body.tools as Array<Record<string, unknown>>)[0]).toEqual({
        type: 'function',
        function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } },
      });
    });

    it('should parse tool call response', async () => {
      const mockResponse = {
        choices: [{
          message: {
            content: '',
            tool_calls: [{
              id: 'tc_1',
              function: { name: 'get_weather', arguments: '{"city":"Beijing"}' },
            }],
          },
        }],
        usage: { prompt_tokens: 15, completion_tokens: 10, total_tokens: 25 },
      };
      globalThis.fetch = mockFetchResponse(mockResponse);

      const result = await client.chat([{ role: 'user', content: 'weather?' }]);

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0]).toEqual({
        id: 'tc_1',
        name: 'get_weather',
        parameters: { city: 'Beijing' },
      });
    });

    it('should parse minimax invoke markup when tool_calls is missing', async () => {
      const invokeMarkup = String.raw`(tool call)
<invoke name=\read_file\>
<parameter name=\path\>docs/文献列表/cases/recv8fLSO2IZxq.md</parameter>
</invoke>
</minimax:tool_call>`;
      const mockResponse = {
        choices: [{
          message: {
            content: invokeMarkup,
          },
        }],
        usage: { prompt_tokens: 18, completion_tokens: 11, total_tokens: 29 },
      };
      globalThis.fetch = mockFetchResponse(mockResponse);

      const result = await client.chat([{ role: 'user', content: 'analyze this paper' }]);

      expect(result.toolCalls).toEqual([
        {
          id: 'tc_invoke_1',
          name: 'read_file',
          parameters: { path: 'docs/文献列表/cases/recv8fLSO2IZxq.md' },
        },
      ]);
    });

    it('should handle API error', async () => {
      globalThis.fetch = mockFetchResponse({ error: 'bad request' }, 400);

      await expect(
        client.chat([{ role: 'user', content: 'Hi' }])
      ).rejects.toThrow(LLMError);
    });

    it('should handle empty choices', async () => {
      globalThis.fetch = mockFetchResponse({ choices: [] });

      await expect(
        client.chat([{ role: 'user', content: 'Hi' }])
      ).rejects.toThrow(LLMError);
    });
  });

  describe('chatStream', () => {
    let client: OpenAIClient;

    beforeEach(() => {
      client = new OpenAIClient({
        provider: 'openai',
        model: 'gpt-4',
        apiKey: MOCK_API_KEY,
        baseUrl: 'https://test.openai.com/v1',
      });
    });

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

    it('should stream text tokens', async () => {
      const sseData = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
        'data: [DONE]\n\n',
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: createSSEStream(sseData),
      }) as typeof globalThis.fetch;

      const tokens: string[] = [];
      for await (const chunk of client.chatStream!(
        [{ role: 'user', content: 'Hi' }],
      )) {
        if (chunk.delta) tokens.push(chunk.delta);
        if (chunk.done) {
          expect(chunk.usage).toBeDefined();
        }
      }

      expect(tokens.join('')).toBe('Hello world');
    });

    it('should stream tool calls', async () => {
      const sseData = [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc_1","function":{"name":"get_weather","arguments":""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Beijing\\"}"}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: createSSEStream(sseData),
      }) as typeof globalThis.fetch;

      let finalToolCalls: unknown;
      for await (const chunk of client.chatStream!(
        [{ role: 'user', content: 'weather?' }],
      )) {
        if (chunk.done && chunk.toolCalls) {
          finalToolCalls = chunk.toolCalls;
        }
      }

      expect(finalToolCalls).toEqual([
        { id: 'tc_1', name: 'get_weather', parameters: { city: 'Beijing' } },
      ]);
    });

    it('should recover tool calls from streamed invoke markup', async () => {
      const sseData = [
        'data: {"choices":[{"delta":{"content":"(tool call)\\n"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"<invoke name=\\"read_file\\">\\n"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"<parameter name=\\"path\\">docs/文献列表/cases/recv8fLSO2IZxq.md</parameter>\\n"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"</invoke>\\n</minimax:tool_call>"}}]}\n\n',
        'data: [DONE]\n\n',
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: createSSEStream(sseData),
      }) as typeof globalThis.fetch;

      let finalToolCalls: unknown;
      for await (const chunk of client.chatStream!(
        [{ role: 'user', content: 'analyze this paper' }],
      )) {
        if (chunk.done) {
          finalToolCalls = chunk.toolCalls;
        }
      }

      expect(finalToolCalls).toEqual([
        {
          id: 'tc_invoke_1',
          name: 'read_file',
          parameters: { path: 'docs/文献列表/cases/recv8fLSO2IZxq.md' },
        },
      ]);
    });

    it('should throw on API error', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      }) as typeof globalThis.fetch;

      await expect(async () => {
        for await (const _chunk of client.chatStream!(
          [{ role: 'user', content: 'Hi' }],
        )) {
          // consume
        }
      }).rejects.toThrow(LLMError);
    });
  });
});

