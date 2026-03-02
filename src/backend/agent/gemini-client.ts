/**
 * Gemini LLM Client - Uses native fetch to call Google Gemini API
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
import {
  sanitizeMessagesForLLM,
  type ILLMClient,
  type LLMCallOptions,
  type LLMStreamChunk,
} from './llm-client.js';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiClient implements ILLMClient {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private temperature: number;
  private maxTokens: number;

  constructor(config: LLMConfig) {
    const apiKey = config.apiKey ?? process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new LLMError(
        'Gemini API key is required. Set apiKey in config or GEMINI_API_KEY env var.',
        'gemini'
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

    const response = await fetch(
      `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...(options?.signal ? { signal: options.signal } : {}),
      }
    );

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error');
      throw new LLMError(
        `Gemini API error: ${response.status} ${errorBody}`,
        'gemini',
        response.status
      );
    }

    const data = (await response.json()) as Record<string, unknown>;
    return this.parseResponse(data);
  }

  async *chatStream(
    messages: Message[],
    tools?: ToolDefinition[],
    options?: LLMCallOptions,
  ): AsyncIterable<LLMStreamChunk> {
    const body = this.buildRequestBody(messages, tools);

    const response = await fetch(
      `${this.baseUrl}/models/${this.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...(options?.signal ? { signal: options.signal } : {}),
      }
    );

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error');
      throw new LLMError(
        `Gemini API error: ${response.status} ${errorBody}`,
        'gemini',
        response.status
      );
    }

    if (!response.body) {
      throw new LLMError('Gemini streaming response has no body', 'gemini');
    }

    yield* this.parseSSEStream(response.body);
  }

  private buildRequestBody(
    messages: Message[],
    tools?: ToolDefinition[]
  ): Record<string, unknown> {
    const sanitizedMessages = sanitizeMessagesForLLM(messages);
    const { systemInstruction, contents } = this.convertMessages(sanitizedMessages);

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: this.temperature,
        maxOutputTokens: this.maxTokens,
      },
    };

    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    if (tools && tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ];
    }

    return body;
  }

  private convertMessages(messages: Message[]): {
    systemInstruction: string | undefined;
    contents: Array<Record<string, unknown>>;
  } {
    const systemParts: string[] = [];
    const contents: Array<Record<string, unknown>> = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemParts.push(getMessageText(msg.content));
        continue;
      }

      if (msg.role === 'tool') {
        const part = {
          functionResponse: {
            name: msg.name ?? msg.toolCallId ?? 'unknown',
            response: { result: getMessageText(msg.content) },
          },
        };

        // Merge consecutive function responses into one user message
        // (Gemini API rejects consecutive messages with the same role)
        const last = contents[contents.length - 1];
        if (last && last.role === 'user' && Array.isArray(last.parts)) {
          (last.parts as Array<Record<string, unknown>>).push(part);
        } else {
          contents.push({
            role: 'user',
            parts: [part],
          });
        }
        continue;
      }

      if (msg.role === 'assistant') {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          const parts: Array<Record<string, unknown>> = [];
          const text = getMessageText(msg.content);
          if (text) {
            parts.push({ text });
          }
          for (const tc of msg.toolCalls) {
            parts.push({
              functionCall: {
                name: tc.name,
                args: tc.parameters,
              },
            });
          }
          contents.push({ role: 'model', parts });
        } else {
          contents.push({
            role: 'model',
            parts: [{ text: getMessageText(msg.content) }],
          });
        }
        continue;
      }

      // user messages - handle multipart content
      if (Array.isArray(msg.content)) {
        const parts: Array<Record<string, unknown>> = [];
        for (const part of msg.content) {
          if (part.type === 'text') {
            parts.push({ text: part.text });
          } else if (part.type === 'image') {
            parts.push({
              inlineData: {
                mimeType: part.image.mimeType,
                data: part.image.data,
              },
            });
          }
        }
        contents.push({ role: 'user', parts });
      } else {
        contents.push({
          role: 'user',
          parts: [{ text: msg.content }],
        });
      }
    }

    return {
      systemInstruction: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
      contents,
    };
  }

  private async *parseSSEStream(
    body: ReadableStream<Uint8Array>,
  ): AsyncIterable<LLMStreamChunk> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usage: LLMResponse['usage'] | undefined;
    const allToolCalls: ToolCall[] = [];

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
          if (payload === '[DONE]') continue;

          let data: Record<string, unknown>;
          try {
            data = JSON.parse(payload) as Record<string, unknown>;
          } catch {
            continue;
          }

          // Extract usage
          const meta = data.usageMetadata as Record<string, number> | undefined;
          if (meta) {
            usage = {
              promptTokens: meta.promptTokenCount ?? 0,
              completionTokens: meta.candidatesTokenCount ?? 0,
              totalTokens: meta.totalTokenCount ?? 0,
            };
          }

          const candidates = data.candidates as Array<Record<string, unknown>> | undefined;
          if (!candidates || candidates.length === 0) continue;

          const candidate = candidates[0]!;

          // Check safety block
          if (candidate.finishReason === 'SAFETY') {
            const safetyRatings = candidate.safetyRatings as Array<Record<string, unknown>> | undefined;
            const blocked = safetyRatings?.filter((r) => r.blocked) ?? [];
            throw new LLMError(
              `Response blocked by safety filters: ${blocked.map((r) => r.category as string).join(', ')}`,
              'gemini'
            );
          }

          const content = candidate.content as Record<string, unknown> | undefined;
          const parts = content?.parts as Array<Record<string, unknown>> | undefined;
          if (!parts) continue;

          for (const part of parts) {
            if (part.text) {
              yield { delta: part.text as string, done: false };
            }
            if (part.functionCall) {
              const fc = part.functionCall as Record<string, unknown>;
              allToolCalls.push({
                id: `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                name: fc.name as string,
                parameters: (fc.args as Record<string, unknown>) ?? {},
              });
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield {
      delta: '',
      done: true,
      usage,
      toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
    };
  }

  private parseResponse(data: Record<string, unknown>): LLMResponse {
    const candidates = data.candidates as Array<Record<string, unknown>> | undefined;
    if (!candidates || candidates.length === 0) {
      throw new LLMError('Gemini API returned no candidates', 'gemini');
    }

    const candidate = candidates[0]!;

    // Check safety block
    if (candidate.finishReason === 'SAFETY') {
      const safetyRatings = candidate.safetyRatings as Array<Record<string, unknown>> | undefined;
      const blocked = safetyRatings?.filter((r) => r.blocked) ?? [];
      throw new LLMError(
        `Response blocked by safety filters: ${blocked.map((r) => r.category as string).join(', ')}`,
        'gemini'
      );
    }

    const content = candidate.content as Record<string, unknown> | undefined;
    const parts = (content?.parts as Array<Record<string, unknown>>) ?? [];

    // Extract text
    const textContent = parts
      .filter((p) => p.text)
      .map((p) => p.text as string)
      .join('');

    // Extract tool calls
    const toolCalls: ToolCall[] = [];
    for (const part of parts) {
      if (part.functionCall) {
        const fc = part.functionCall as Record<string, unknown>;
        toolCalls.push({
          id: `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: fc.name as string,
          parameters: (fc.args as Record<string, unknown>) ?? {},
        });
      }
    }

    // Extract usage
    const meta = data.usageMetadata as Record<string, number> | undefined;

    return {
      content: textContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        promptTokens: meta?.promptTokenCount ?? 0,
        completionTokens: meta?.candidatesTokenCount ?? 0,
        totalTokens: meta?.totalTokenCount ?? 0,
      },
    };
  }
}
