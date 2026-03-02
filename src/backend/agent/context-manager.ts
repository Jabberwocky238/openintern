/**
 * ContextManager - Build and manage LLM context
 *
 * Features:
 * - Build LLM context (system prompt + history)
 * - Context trimming (token limit)
 * - Memory retrieval
 */

import type {
  ContextConfig,
  LLMContext,
  Message,
  ContentPart,
} from '../../types/agent.js';
import { getMessageText } from '../../types/agent.js';
import type { MemoryItem } from '../../types/memory.js';
import { MemoryStore } from '../store/memory-store.js';
import { TokenCounter } from './token-counter.js';
import { ContextTrimmer } from './context-trimmer.js';
import { logger } from '@openintern/utils';

const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant. You have access to tools that are provided via the function calling interface â€?use them when appropriate.

Guidelines:
- You do NOT have built-in memory across conversations. If the user asks a personal question (like your name) or references past information, you MUST call memory.search first before answering. Never guess or make up information.
- For file operations, all paths are relative to your working directory.
- Always respond in the same language as the user's message.`;

const DEFAULT_CONFIG: ContextConfig = {
  maxTokens: 4000,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  includeMemory: true,
  maxMessages: 20,
};

/**
 * Context availability status
 */
export interface ContextAvailability {
  available: boolean;
  totalTokens: number;
  warning?: string;
}

/**
 * ContextManager class for managing LLM context
 */
export class ContextManager {
  private config: ContextConfig;
  private messages: Message[] = [];
  private memoryStore: MemoryStore;
  private runId: string;
  private sessionKey: string;
  private currentStepNumber = 0;
  private tokenCounter: TokenCounter;
  private contextTrimmer: ContextTrimmer;

  constructor(
    runId: string,
    sessionKey: string,
    config: Partial<ContextConfig> = {},
    baseDir: string = 'data'
  ) {
    this.runId = runId;
    this.sessionKey = sessionKey;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.memoryStore = new MemoryStore(`${baseDir}/memory/shared`);
    this.tokenCounter = new TokenCounter();
    this.contextTrimmer = new ContextTrimmer(this.tokenCounter, {
      preserveTurns: this.config.preserveTurns ?? 3,
    });
  }

  /**
   * Get current step number
   */
  getCurrentStepNumber(): number {
    return this.currentStepNumber;
  }

  /**
   * Increment step number
   */
  incrementStep(): number {
    this.currentStepNumber++;
    return this.currentStepNumber;
  }

  /**
   * Set step number
   */
  setStepNumber(step: number): void {
    this.currentStepNumber = step;
  }

  /**
   * Add a message to the context
   */
  addMessage(role: Message['role'], content: string | ContentPart[], toolCallId?: string, toolCalls?: Message['toolCalls']): void {
    const message: Message = { role, content };
    if (toolCallId) {
      message.toolCallId = toolCallId;
    }
    if (toolCalls && toolCalls.length > 0) {
      message.toolCalls = toolCalls;
    }
    this.messages.push(message);
    const textLen = typeof content === 'string' ? content.length : getMessageText(content).length;
    logger.debug('Message added to context', { role, contentLength: textLen });
  }

  /**
   * Get all messages
   */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /**
   * Clear all messages
   */
  clearMessages(): void {
    this.messages = [];
  }

  /**
   * Estimate token count for a string using TokenCounter.
   * Synchronous version for backward compatibility.
   */
  private estimateTokens(text: string): number {
    return this.tokenCounter.countSync(text);
  }

  /**
   * Check context window availability.
   * Returns whether execution should proceed, with optional warning.
   */
  async checkContextAvailability(): Promise<ContextAvailability> {
    const totalTokens = await this.tokenCounter.countMessages(this.messages);
    const minTokens = this.config.minContextTokens ?? 16000;
    const warnTokens = this.config.warnContextTokens ?? 32000;
    const modelMax = this.config.modelMaxTokens ?? 128000;
    const available = modelMax - totalTokens;

    if (available < minTokens) {
      return {
        available: false,
        totalTokens,
        warning: `Context nearly full: ${totalTokens} tokens used, only ${available} remaining (min: ${minTokens})`,
      };
    }

    if (available < warnTokens) {
      return {
        available: true,
        totalTokens,
        warning: `Context running low: ${totalTokens} tokens used, ${available} remaining`,
      };
    }

    return { available: true, totalTokens };
  }

  /**
   * Retrieve relevant memories for a query
   */
  async retrieveMemory(query: string, topK: number = 3): Promise<MemoryItem[]> {
    if (!this.config.includeMemory) {
      return [];
    }

    try {
      const hybridResults = await this.memoryStore.searchHybrid(query, topK);
      const memories = hybridResults.map((hr) => hr.item);
      logger.debug('Memory retrieved (hybrid)', { query, count: memories.length });
      return memories;
    } catch (error) {
      logger.warn('Failed to retrieve memory', {
        query,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Build the LLM context
   */
  async buildContext(): Promise<LLMContext> {
    // Auto-retrieve relevant memories based on last user message
    let memoryContext = '';
    if (this.config.includeMemory) {
      const lastUserMsg = [...this.messages].reverse().find((m) => m.role === 'user');
      if (lastUserMsg) {
        const memories = await this.retrieveMemory(getMessageText(lastUserMsg.content));
        if (memories.length > 0) {
          const memoryLines = memories.map((m) => `- ${m.content}`).join('\n');
          memoryContext = `\n\nRelevant memories:\n${memoryLines}`;
        }
      }
    }

    // Inject working directory info
    let workDirContext = '';
    if (this.config.workDir) {
      workDirContext = `\n\nFile tools working directory: ${this.config.workDir}\nAll file paths are relative to this directory. You can only access files within this directory.`;
    }

    const systemPrompt = this.config.systemPrompt + workDirContext + memoryContext;

    // Reserve tokens for system prompt
    const systemTokens = await this.tokenCounter.count(systemPrompt);
    const availableTokens = this.config.maxTokens - systemTokens;

    // Trim messages using turn-based trimmer
    const trimmedMessages = await this.contextTrimmer.trim(
      this.messages,
      availableTokens,
    );

    // Calculate total tokens
    const messageTokens = await this.tokenCounter.countMessages(trimmedMessages);
    const totalTokens = systemTokens + messageTokens;

    logger.debug('Context built', {
      messageCount: trimmedMessages.length,
      totalTokens,
    });

    return {
      systemPrompt,
      messages: trimmedMessages,
      totalTokens,
    };
  }

}

