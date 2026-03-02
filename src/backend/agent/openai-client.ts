/**
 * OpenAI LLM Client - Uses native fetch to call OpenAI-compatible APIs
 */

import type {
  LLMConfig,
  LLMResponse,
  Message,
  ToolDefinition,
  ToolCall,
} from '../../types/agent.js';
import { getMessageText } from '../../types/agent.js';
import { LLMError } from '../../utils/errors.js';
import type { ILLMClient, LLMCallOptions, LLMStreamChunk } from './llm-client.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export class OpenAIClient implements ILLMClient {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private temperature: number;
  private maxTokens: number;

  constructor(config: LLMConfig) {
    const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new LLMError(
        'OpenAI API key is required. Set apiKey in config or OPENAI_API_KEY env var.',
        'openai'
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.model = config.model;
    this.temperature = config.temperature ?? 0.7;
    this.maxTokens = config.maxTokens ?? 2000;
  }

  async chat(messages: Message[], tools?: ToolDefinition[], options?: LLMCallOptions): Promise<LLMResponse> {
    const body = this.buildRequestBody(messages, tools);

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      ...(options?.signal ? { signal: options.signal } : {}),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error');
      throw new LLMError(
        `OpenAI API error: ${response.status} ${errorBody}`,
        'openai',
        response.status
      );
    }

    const data = (await response.json()) as Record<string, unknown>;
    return this.parseResponse(data);
  }

  private buildRequestBody(
    messages: Message[],
    tools?: ToolDefinition[]
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((m) => this.mapMessage(m)),
      temperature: this.temperature,
      max_completion_tokens: this.maxTokens,
    };

    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => this.mapTool(t));
    }

    return body;
  }

  private mapMessage(msg: Message): Record<string, unknown> {
    const mapped: Record<string, unknown> = {
      role: msg.role,
    };

    // Handle multipart content for user messages
    if (Array.isArray(msg.content)) {
      const parts: Array<Record<string, unknown>> = [];
      for (const part of msg.content) {
        if (part.type === 'text') {
          parts.push({ type: 'text', text: part.text });
        } else if (part.type === 'image') {
          parts.push({
            type: 'image_url',
            image_url: {
              url: `data:${part.image.mimeType};base64,${part.image.data}`,
            },
          });
        }
      }
      mapped.content = parts;
    } else {
      mapped.content = msg.content;
    }

    if (msg.role === 'tool' && msg.toolCallId) {
      mapped.tool_call_id = msg.toolCallId;
      mapped.content = getMessageText(msg.content);
    }

    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      mapped.content = getMessageText(msg.content);
      mapped.tool_calls = msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.parameters),
        },
      }));
    }

    if (msg.name) {
      mapped.name = msg.name;
    }

    return mapped;
  }

  private mapTool(tool: ToolDefinition): Record<string, unknown> {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    };
  }

  async *chatStream(
    messages: Message[],
    tools?: ToolDefinition[],
    options?: LLMCallOptions,
  ): AsyncIterable<LLMStreamChunk> {
    const body = this.buildRequestBody(messages, tools);
    body['stream'] = true;
    body['stream_options'] = { include_usage: true };

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      ...(options?.signal ? { signal: options.signal } : {}),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error');
      throw new LLMError(
        `OpenAI API error: ${response.status} ${errorBody}`,
        'openai',
        response.status,
      );
    }

    if (!response.body) {
      throw new LLMError('OpenAI streaming response has no body', 'openai');
    }

    yield* this.parseSSEStream(response.body);
  }

  private async *parseSSEStream(
    body: ReadableStream<Uint8Array>,
  ): AsyncIterable<LLMStreamChunk> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let textBuffer = '';
    // Accumulate tool call fragments: index -> { id, name, arguments }
    const toolCallAccum = new Map<number, { id: string; name: string; arguments: string }>();
    let usage: LLMResponse['usage'] | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const payload = trimmed.slice(6);
          if (payload === '[DONE]') {
            yield { delta: '', done: true, usage, toolCalls: this.resolveToolCalls(toolCallAccum, textBuffer) };
            return;
          }

          let data: Record<string, unknown>;
          try {
            data = JSON.parse(payload) as Record<string, unknown>;
          } catch {
            continue;
          }

          // Extract usage if present
          const u = data.usage as Record<string, number> | undefined;
          if (u) {
            usage = {
              promptTokens: u.prompt_tokens ?? 0,
              completionTokens: u.completion_tokens ?? 0,
              totalTokens: u.total_tokens ?? 0,
            };
          }

          const choices = data.choices as Array<Record<string, unknown>> | undefined;
          if (!choices || choices.length === 0) continue;

          const choice = choices[0]!;
          const delta = choice.delta as Record<string, unknown> | undefined;
          if (!delta) continue;

          // Text content delta
          const textDelta = (delta.content as string) ?? '';
          if (textDelta) {
            textBuffer += textDelta;
            yield { delta: textDelta, done: false };
          }

          // Tool call deltas
          const tcDeltas = delta.tool_calls as Array<Record<string, unknown>> | undefined;
          if (tcDeltas) {
            for (const tcd of tcDeltas) {
              const idx = tcd.index as number;
              const fn = tcd.function as Record<string, unknown> | undefined;
              if (!toolCallAccum.has(idx)) {
                toolCallAccum.set(idx, {
                  id: (tcd.id as string) ?? '',
                  name: fn?.name as string ?? '',
                  arguments: '',
                });
              }
              const acc = toolCallAccum.get(idx)!;
              if (tcd.id) acc.id = tcd.id as string;
              if (fn?.name) acc.name = fn.name as string;
              if (fn?.arguments) acc.arguments += fn.arguments as string;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // If we exit without [DONE], emit final chunk
    yield { delta: '', done: true, usage, toolCalls: this.resolveToolCalls(toolCallAccum, textBuffer) };
  }

  private buildToolCalls(
    accum: Map<number, { id: string; name: string; arguments: string }>,
  ): ToolCall[] | undefined {
    if (accum.size === 0) return undefined;
    const result: ToolCall[] = [];
    const sorted = [...accum.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, tc] of sorted) {
      let parameters: Record<string, unknown> = {};
      try {
        parameters = JSON.parse(tc.arguments) as Record<string, unknown>;
      } catch {
        // partial or invalid JSON
      }
      result.push({ id: tc.id, name: tc.name, parameters });
    }
    return result.length > 0 ? result : undefined;
  }

  private resolveToolCalls(
    accum: Map<number, { id: string; name: string; arguments: string }>,
    content: string,
  ): ToolCall[] | undefined {
    const toolCalls = this.buildToolCalls(accum);
    if (toolCalls && toolCalls.length > 0) {
      return toolCalls;
    }
    return this.parseInvokeToolCalls(content);
  }

  private parseResponse(data: Record<string, unknown>): LLMResponse {
    const choices = data.choices as Array<Record<string, unknown>>;
    if (!choices || choices.length === 0) {
      throw new LLMError('OpenAI API returned no choices', 'openai');
    }

    const choice = choices[0]!;
    const message = choice.message as Record<string, unknown>;
    const content = (message.content as string) ?? '';
    const toolCalls = this.parseMessageToolCalls(message, content);

    // Parse usage
    const usage = data.usage as Record<string, number> | undefined;
    const promptTokens = usage?.prompt_tokens ?? 0;
    const completionTokens = usage?.completion_tokens ?? 0;

    return {
      content,
      toolCalls,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
    };
  }

  private parseMessageToolCalls(
    message: Record<string, unknown>,
    content: string,
  ): ToolCall[] | undefined {
    const rawToolCalls = message.tool_calls as Array<Record<string, unknown>> | undefined;
    if (rawToolCalls && rawToolCalls.length > 0) {
      return rawToolCalls.map((tc) => this.parseRawToolCall(tc));
    }
    return this.parseInvokeToolCalls(content);
  }

  private parseRawToolCall(tc: Record<string, unknown>): ToolCall {
    const fn = tc.function as Record<string, unknown> | undefined;
    let parameters: Record<string, unknown> = {};
    if (typeof fn?.arguments === 'string') {
      try {
        parameters = JSON.parse(fn.arguments) as Record<string, unknown>;
      } catch {
        // If JSON parsing fails, use empty object
      }
    }
    return {
      id: (tc.id as string) ?? '',
      name: (fn?.name as string) ?? '',
      parameters,
    };
  }

  private parseInvokeToolCalls(content: string): ToolCall[] | undefined {
    if (!content.includes('<invoke')) {
      return undefined;
    }

    const calls: ToolCall[] = [];
    const invokePattern = /<invoke\b([^>]*)>([\s\S]*?)<\/invoke>/gi;
    let match: RegExpExecArray | null = invokePattern.exec(content);
    while (match) {
      const name = this.parseMarkupAttribute(match[1] ?? '', 'name');
      if (name) {
        calls.push({
          id: `tc_invoke_${calls.length + 1}`,
          name,
          parameters: this.parseInvokeParameters(match[2] ?? ''),
        });
      }
      match = invokePattern.exec(content);
    }

    return calls.length > 0 ? calls : undefined;
  }

  private parseInvokeParameters(invokeContent: string): Record<string, unknown> {
    const parameters: Record<string, unknown> = {};
    const parameterPattern = /<parameter\b([^>]*)>([\s\S]*?)<\/parameter>/gi;
    let match: RegExpExecArray | null = parameterPattern.exec(invokeContent);
    while (match) {
      const key = this.parseMarkupAttribute(match[1] ?? '', 'name');
      if (key) {
        parameters[key] = (match[2] ?? '').trim();
      }
      match = parameterPattern.exec(invokeContent);
    }
    return parameters;
  }

  private parseMarkupAttribute(attrs: string, attrName: string): string | undefined {
    const escapedAttrName = attrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
      `${escapedAttrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\\\([^\\\\>]*)\\\\|([^\\s>]+))`,
      'i',
    );
    const match = pattern.exec(attrs);
    if (!match) {
      return undefined;
    }
    const value = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? '')
      .trim()
      .replace(/^\\+|\\+$/g, '')
      .replace(/^["']|["']$/g, '');
    return value.length > 0 ? value : undefined;
  }
}
