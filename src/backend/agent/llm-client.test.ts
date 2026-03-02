/**
 * LLM Client tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockLLMClient, createLLMClient, sanitizeMessagesForLLM } from './llm-client.js';
import { OpenAIClient } from './openai-client.js';
import { AnthropicClient } from './anthropic-client.js';
import type { Message, ToolDefinition } from '../../types/agent.js';

describe('MockLLMClient', () => {
  let client: MockLLMClient;

  beforeEach(() => {
    client = new MockLLMClient({
      provider: 'mock',
      model: 'test-model',
    });
  });

  it('should return default response', async () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello' },
    ];

    const response = await client.chat(messages);

    expect(response.content).toBe('I have completed the task.');
    expect(response.usage.totalTokens).toBeGreaterThan(0);
  });

  it('should return predefined response for specific input', async () => {
    const customResponse = {
      content: 'Custom response',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };

    client.setResponse('test input', customResponse);

    const messages: Message[] = [
      { role: 'user', content: 'test input' },
    ];

    const response = await client.chat(messages);

    expect(response.content).toBe('Custom response');
  });

  it('should track call count', async () => {
    expect(client.getCallCount()).toBe(0);

    await client.chat([{ role: 'user', content: 'Hello' }]);
    expect(client.getCallCount()).toBe(1);

    await client.chat([{ role: 'user', content: 'World' }]);
    expect(client.getCallCount()).toBe(2);

    client.resetCallCount();
    expect(client.getCallCount()).toBe(0);
  });
});

describe('sanitizeMessagesForLLM', () => {
  it('replaces empty string content with placeholders', () => {
    const messages: Message[] = [
      { role: 'user', content: '' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'tc_1', name: 'read_file', parameters: { path: 'a' } }] },
      { role: 'tool', content: '{"ok":true}', toolCallId: 'tc_1' },
    ];

    const sanitized = sanitizeMessagesForLLM(messages);
    expect(sanitized[0]?.content).toBe('(empty)');
    expect(sanitized[1]?.content).toBe('(tool call)');
  });

  it('removes empty text blocks but preserves images', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '' },
          { type: 'image', image: { data: 'abc', mimeType: 'image/png' } },
        ],
      },
    ];

    const sanitized = sanitizeMessagesForLLM(messages);
    expect(Array.isArray(sanitized[0]?.content)).toBe(true);
    const parts = sanitized[0]?.content as Message['content'];
    if (Array.isArray(parts)) {
      expect(parts).toHaveLength(1);
      expect(parts[0]?.type).toBe('image');
    }
  });

  it('drops orphan tool messages and unresolved assistant tool calls', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc_orphan', name: 'read_file', parameters: { path: 'a.md' } }],
      },
      { role: 'tool', content: '{"ok":true}', toolCallId: 'tc_missing' },
      {
        role: 'assistant',
        content: 'final summary',
      },
    ];

    const sanitized = sanitizeMessagesForLLM(messages);
    expect(sanitized).toHaveLength(1);
    expect(sanitized[0]?.role).toBe('assistant');
    expect(sanitized[0]?.content).toBe('final summary');
  });

  it('keeps valid assistant/tool call pairs', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: 'running tool',
        toolCalls: [{ id: 'tc_1', name: 'grep_files', parameters: { pattern: 'foo' } }],
      },
      { role: 'tool', content: '{"matches":[]}', toolCallId: 'tc_1' },
    ];

    const sanitized = sanitizeMessagesForLLM(messages);
    expect(sanitized).toHaveLength(2);
    expect(sanitized[0]?.role).toBe('assistant');
    expect(sanitized[0]?.toolCalls?.[0]?.id).toBe('tc_1');
    expect(sanitized[1]?.role).toBe('tool');
    expect(sanitized[1]?.toolCallId).toBe('tc_1');
  });

  it('drops out-of-order tool results that appear before tool calls', () => {
    const messages: Message[] = [
      { role: 'user', content: 'question' },
      { role: 'tool', content: '{"ok":true}', toolCallId: 'tc_1' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc_1', name: 'read_file', parameters: { path: 'a.md' } }],
      },
      { role: 'assistant', content: 'final summary' },
    ];

    const sanitized = sanitizeMessagesForLLM(messages);
    expect(sanitized.some((message) => message.role === 'tool')).toBe(false);
    expect(sanitized.some((message) => message.role === 'assistant' && message.toolCalls?.length)).toBe(false);
    expect(sanitized[sanitized.length - 1]?.content).toBe('final summary');
  });

  it('aligns history to first user turn after system messages', () => {
    const messages: Message[] = [
      { role: 'system', content: 'sys prompt' },
      { role: 'assistant', content: 'leftover assistant' },
      { role: 'tool', content: '{"stale":true}', toolCallId: 'tc_old' },
      { role: 'user', content: 'current question' },
    ];

    const sanitized = sanitizeMessagesForLLM(messages);
    expect(sanitized).toHaveLength(2);
    expect(sanitized[0]?.role).toBe('system');
    expect(sanitized[1]?.role).toBe('user');
    expect(sanitized[1]?.content).toBe('current question');
  });
});

describe('MockLLMClient with tools', () => {
  let client: MockLLMClient;
  let tools: ToolDefinition[];

  beforeEach(() => {
    client = new MockLLMClient(
      { provider: 'mock', model: 'test-model' },
      { simulateToolCalls: true }
    );

    tools = [
      {
        name: 'memory_write',
        description: 'Write to memory',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'memory_search',
        description: 'Search memory',
        parameters: { type: 'object', properties: {} },
      },
    ];
  });

  it('should simulate memory_write tool call', async () => {
    const messages: Message[] = [
      { role: 'user', content: 'Please remember this information' },
    ];

    const response = await client.chat(messages, tools);

    expect(response.toolCalls).toBeDefined();
    expect(response.toolCalls?.length).toBe(1);
    expect(response.toolCalls?.[0]?.name).toBe('memory_write');
  });

  it('should simulate memory_search tool call', async () => {
    const messages: Message[] = [
      { role: 'user', content: 'Search for something' },
    ];

    const response = await client.chat(messages, tools);

    expect(response.toolCalls).toBeDefined();
    expect(response.toolCalls?.length).toBe(1);
    expect(response.toolCalls?.[0]?.name).toBe('memory_search');
  });
});

describe('createLLMClient', () => {
  const originalOpenAIKey = process.env.OPENAI_API_KEY;
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    if (originalOpenAIKey !== undefined) {
      process.env.OPENAI_API_KEY = originalOpenAIKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
    if (originalAnthropicKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('should create mock client', () => {
    const client = createLLMClient({
      provider: 'mock',
      model: 'test-model',
    });
    expect(client).toBeInstanceOf(MockLLMClient);
  });

  it('should create OpenAI client', () => {
    const client = createLLMClient({
      provider: 'openai',
      model: 'gpt-4',
      apiKey: 'test-key',
    });
    expect(client).toBeInstanceOf(OpenAIClient);
  });

  it('should create Anthropic client', () => {
    const client = createLLMClient({
      provider: 'anthropic',
      model: 'claude-3-sonnet',
      apiKey: 'test-key',
    });
    expect(client).toBeInstanceOf(AnthropicClient);
  });
});
