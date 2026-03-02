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
  const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
  const calls = mockFn.mock.calls as Array<[string, { body: string }]>;
  return JSON.parse(calls[0]![1].body) as Record<string, unknown>;
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

    it('should handle empty content', async () => {
      globalThis.fetch = mockFetchResponse({ content: [] });

      await expect(
        client.chat([{ role: 'user', content: 'Hi' }])
      ).rejects.toThrow(LLMError);
    });
  });
});
