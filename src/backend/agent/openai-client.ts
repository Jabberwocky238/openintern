/**
 * OpenAI LLM Client - Uses native fetch to call OpenAI-compatible APIs
 */

import type {
  LLMConfig,
  LLMResponse,
  Message,
  ToolDefinition,
  ToolCall,
} from '@openintern/types/agent.js';
import { getMessageText } from '@openintern/types/agent.js';
import { LLMError } from '@openintern/utils';
import {
  sanitizeMessagesForLLM,
  type ILLMClient,
  type LLMCallOptions,
  type LLMStreamChunk,
} from './llm-client.js';

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
    const sanitizedMessages = sanitizeMessagesForLLM(messages);
    const body: Record<string, unknown> = {
      model: this.model,
      messages: sanitizedMessages.map((m) => this.mapMessage(m)),
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
    let fullText = '';
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
            const toolCalls = this.resolveToolCallsFromAccumAndContent(toolCallAccum, fullText);
            yield { delta: '', done: true, usage, toolCalls };
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
            fullText += textDelta;
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
    const toolCalls = this.resolveToolCallsFromAccumAndContent(toolCallAccum, fullText);
    yield { delta: '', done: true, usage, toolCalls };
  }

  private resolveToolCallsFromAccumAndContent(
    accum: Map<number, { id: string; name: string; arguments: string }>,
    content: string,
  ): ToolCall[] | undefined {
    const nativeToolCalls = this.buildToolCalls(accum);
    if (nativeToolCalls && nativeToolCalls.length > 0) {
      return nativeToolCalls;
    }
    const invokeToolCalls = this.extractInvokeToolCalls(content);
    return invokeToolCalls.length > 0 ? invokeToolCalls : undefined;
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

  private parseResponse(data: Record<string, unknown>): LLMResponse {
    const choices = data.choices as Array<Record<string, unknown>>;
    if (!choices || choices.length === 0) {
      throw new LLMError('OpenAI API returned no choices', 'openai');
    }

    const choice = choices[0]!;
    const message = choice.message as Record<string, unknown>;
    const content = this.extractMessageContent(message.content);

    // Parse tool calls
    let toolCalls: ToolCall[] | undefined;
    const rawToolCalls = message.tool_calls as Array<Record<string, unknown>> | undefined;
    if (rawToolCalls && rawToolCalls.length > 0) {
      toolCalls = rawToolCalls.map((tc) => {
        const fn = tc.function as Record<string, unknown>;
        let parameters: Record<string, unknown> = {};
        try {
          parameters = JSON.parse(fn.arguments as string) as Record<string, unknown>;
        } catch {
          // If JSON parsing fails, use empty object
        }
        return {
          id: tc.id as string,
          name: fn.name as string,
          parameters,
        };
      });
    }

    if ((!toolCalls || toolCalls.length === 0) && content) {
      const invokeToolCalls = this.extractInvokeToolCalls(content);
      if (invokeToolCalls.length > 0) {
        toolCalls = invokeToolCalls;
      }
    }

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

  private extractMessageContent(rawContent: unknown): string {
    if (typeof rawContent === 'string') {
      return rawContent;
    }
    if (!Array.isArray(rawContent)) {
      return '';
    }
    let content = '';
    for (const part of rawContent) {
      if (typeof part === 'string') {
        content += part;
        continue;
      }
      if (
        part &&
        typeof part === 'object' &&
        'text' in part &&
        typeof (part as { text?: unknown }).text === 'string'
      ) {
        content += (part as { text: string }).text;
      }
    }
    return content;
  }

  private extractInvokeToolCalls(content: string): ToolCall[] {
    if (!content.includes('<invoke')) {
      return [];
    }

    const trimmed = content.trim();
    const hasExplicitWrapper = /<\/?minimax:tool_call\b/i.test(content) || /^\(tool call\)/i.test(trimmed);
    const residualContent = this.stripInvokeMarkup(content).replace(/^\(tool call\)\s*/i, '').trim();
    if (!hasExplicitWrapper && residualContent.length > 0) {
      return [];
    }

    const invokeRegex = /<invoke\b([^>]*)>([\s\S]*?)<\/invoke>/gi;
    const toolCalls: ToolCall[] = [];
    let invokeIndex = 0;

    while (true) {
      const match = invokeRegex.exec(content);
      if (!match) break;

      const attrs = match[1] ?? '';
      const body = match[2] ?? '';
      const name = this.extractTagAttribute(attrs, 'name');
      if (!name) continue;

      const id = this.extractTagAttribute(attrs, 'id') ?? `tc_invoke_${invokeIndex + 1}`;
      invokeIndex += 1;

      const parameters = this.extractInvokeParameters(body);
      toolCalls.push({ id, name, parameters });
    }

    return toolCalls;
  }

  private stripInvokeMarkup(content: string): string {
    return content
      .replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, '')
      .replace(/<\/?minimax:tool_call\b[^>]*>/gi, '');
  }

  private extractInvokeParameters(body: string): Record<string, unknown> {
    const parameterRegex = /<parameter\b([^>]*)>([\s\S]*?)<\/parameter>/gi;
    const parameters: Record<string, unknown> = {};
    let foundParameter = false;

    while (true) {
      const match = parameterRegex.exec(body);
      if (!match) break;

      const attrs = match[1] ?? '';
      const rawValue = match[2] ?? '';
      const name = this.extractTagAttribute(attrs, 'name');
      if (!name) continue;

      foundParameter = true;
      parameters[name] = this.parseParameterValue(rawValue);
    }

    if (foundParameter) {
      return parameters;
    }

    const directObject = this.tryParseJsonObject(body.trim());
    if (directObject) {
      return directObject;
    }

    return {};
  }

  private extractTagAttribute(attrs: string, key: string): string | undefined {
    const attrRegex = new RegExp(`\\b${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
    const match = attrs.match(attrRegex);
    const raw = match?.[1] ?? match?.[2] ?? match?.[3];
    if (!raw) {
      return undefined;
    }
    const cleaned = raw.replace(/^[\\'"`]+|[\\'"`]+$/g, '').trim();
    return cleaned.length > 0 ? cleaned : undefined;
  }

  private parseParameterValue(rawValue: string): unknown {
    const trimmed = rawValue.trim();
    if (!trimmed) {
      return '';
    }

    const jsonValue = this.tryParseJson(trimmed);
    if (jsonValue !== undefined) {
      return jsonValue;
    }

    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (!Number.isNaN(numeric)) {
        return numeric;
      }
    }

    if (/^(true|false)$/i.test(trimmed)) {
      return trimmed.toLowerCase() === 'true';
    }

    if (/^null$/i.test(trimmed)) {
      return null;
    }

    return trimmed;
  }

  private tryParseJsonObject(raw: string): Record<string, unknown> | undefined {
    if (!raw) {
      return undefined;
    }
    const parsed = this.tryParseJson(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  }

  private tryParseJson(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
}

