/**
 * Config Loader - Load agent configuration from file and environment
 *
 * Priority (low to high):
 * 1. Config file (agent.config.ts/js/json)
 * 2. Environment variables
 * 3. CLI arguments (handled by callers)
 * 4. API request params (handled by callers)
 */

import { readFile } from 'fs/promises';
import { resolve, extname } from 'path';
import { existsSync } from 'fs';
import type { AgentConfig, LLMConfig } from '../types/agent.js';
import { logger } from '../utils/logger.js';

const CONFIG_FILE_NAMES = [
  'agent.config.json',
  'agent.config.js',
  'agent.config.mjs',
];

let cachedConfig: AgentConfig | null = null;

/**
 * Find the config file path in the given directory
 */
function findConfigFile(dir: string): string | null {
  for (const name of CONFIG_FILE_NAMES) {
    const filePath = resolve(dir, name);
    if (existsSync(filePath)) {
      return filePath;
    }
  }
  return null;
}

/**
 * Load config from a JSON file
 */
async function loadJsonConfig(filePath: string): Promise<AgentConfig> {
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content) as AgentConfig;
}

/**
 * Load config from a JS/MJS file (ESM dynamic import)
 */
async function loadJsConfig(filePath: string): Promise<AgentConfig> {
  const absolutePath = resolve(filePath);
  const mod = (await import(absolutePath)) as { default?: AgentConfig };
  return mod.default ?? (mod as unknown as AgentConfig);
}

/**
 * Load config from file
 */
async function loadConfigFile(dir: string): Promise<AgentConfig> {
  const filePath = findConfigFile(dir);
  if (!filePath) {
    return {};
  }

  logger.debug('Loading config file', { path: filePath });

  const ext = extname(filePath);
  if (ext === '.json') {
    return loadJsonConfig(filePath);
  }
  return loadJsConfig(filePath);
}

/**
 * Read LLM-related environment variables and merge into config
 */
function applyEnvOverrides(config: AgentConfig): AgentConfig {
  const result = structuredClone(config);

  // LLM env overrides
  const envProvider = process.env['LLM_PROVIDER'];
  const envModel = process.env['LLM_MODEL'];
  const envBaseUrl = process.env['LLM_BASE_URL'];
  const envApiKey = process.env['LLM_API_KEY'];
  const envTemp = process.env['LLM_TEMPERATURE'];
  const envMaxTokens = process.env['LLM_MAX_TOKENS'];
  const envOpenAIBaseUrl = process.env['OPENAI_BASE_URL'];
  const envAnthropicBaseUrl = process.env['ANTHROPIC_BASE_URL'];
  const envPlannerProvider = process.env['PLANNER_LLM_PROVIDER'];
  const envPlannerModel = process.env['PLANNER_LLM_MODEL'];
  const envPlannerBaseUrl = process.env['PLANNER_LLM_BASE_URL'];
  const envPlannerApiKey = process.env['PLANNER_LLM_API_KEY'];
  const envPlannerTemp = process.env['PLANNER_LLM_TEMPERATURE'];
  const envPlannerMaxTokens = process.env['PLANNER_LLM_MAX_TOKENS'];

  if (
    envProvider ||
    envModel ||
    envBaseUrl ||
    envApiKey ||
    envTemp ||
    envMaxTokens ||
    envOpenAIBaseUrl ||
    envAnthropicBaseUrl
  ) {
    if (!result.llm) result.llm = {};
    if (envProvider) result.llm.provider = envProvider as 'openai' | 'anthropic' | 'gemini' | 'mock';
    if (envModel) result.llm.model = envModel;
    if (envBaseUrl) result.llm.baseUrl = envBaseUrl;
    if (envApiKey) result.llm.apiKey = envApiKey;
    if (envTemp) result.llm.temperature = parseFloat(envTemp);
    if (envMaxTokens) result.llm.maxTokens = parseInt(envMaxTokens, 10);
  }

  // Planner LLM env overrides
  if (
    envPlannerProvider ||
    envPlannerModel ||
    envPlannerBaseUrl ||
    envPlannerApiKey ||
    envPlannerTemp ||
    envPlannerMaxTokens
  ) {
    if (!result.planner) result.planner = {};
    if (!result.planner.llm) result.planner.llm = {};
    if (envPlannerProvider) {
      result.planner.llm.provider = envPlannerProvider as 'openai' | 'anthropic' | 'gemini' | 'mock';
    }
    if (envPlannerModel) result.planner.llm.model = envPlannerModel;
    if (envPlannerBaseUrl) result.planner.llm.baseUrl = envPlannerBaseUrl;
    if (envPlannerApiKey) result.planner.llm.apiKey = envPlannerApiKey;
    if (envPlannerTemp) result.planner.llm.temperature = parseFloat(envPlannerTemp);
    if (envPlannerMaxTokens) result.planner.llm.maxTokens = parseInt(envPlannerMaxTokens, 10);
  }

  // Legacy API key env vars (lower priority than LLM_API_KEY)
  if (!result.llm?.apiKey) {
    const openaiKey = process.env['OPENAI_API_KEY'];
    const anthropicKey = process.env['ANTHROPIC_API_KEY'];
    if (openaiKey || anthropicKey) {
      if (!result.llm) result.llm = {};
      if (openaiKey && (!result.llm.provider || result.llm.provider === 'openai')) {
        result.llm.apiKey = openaiKey;
        if (!result.llm.provider) result.llm.provider = 'openai';
        if (!result.llm.model) result.llm.model = 'gpt-4o';
      } else if (anthropicKey && (!result.llm.provider || result.llm.provider === 'anthropic')) {
        result.llm.apiKey = anthropicKey;
        if (!result.llm.provider) result.llm.provider = 'anthropic';
        if (!result.llm.model) result.llm.model = 'claude-sonnet-4-20250514';
      }
    }
  }

  // Compatibility base URL env vars when LLM_BASE_URL is not explicitly set.
  if (!envBaseUrl) {
    const provider = result.llm?.provider;
    if (provider === 'openai' && envOpenAIBaseUrl) {
      if (!result.llm) result.llm = {};
      result.llm.baseUrl = envOpenAIBaseUrl;
    } else if (provider === 'anthropic' && envAnthropicBaseUrl) {
      if (!result.llm) result.llm = {};
      result.llm.baseUrl = envAnthropicBaseUrl;
    } else if (!provider && envAnthropicBaseUrl && !envOpenAIBaseUrl) {
      if (!result.llm) result.llm = {};
      result.llm.provider = 'anthropic';
      result.llm.baseUrl = envAnthropicBaseUrl;
      if (!result.llm.model) {
        result.llm.model = 'claude-sonnet-4-20250514';
      }
    } else if (!provider && envOpenAIBaseUrl && !envAnthropicBaseUrl) {
      if (!result.llm) result.llm = {};
      result.llm.provider = 'openai';
      result.llm.baseUrl = envOpenAIBaseUrl;
      if (!result.llm.model) {
        result.llm.model = 'gpt-4o';
      }
    }
  }

  // Server env overrides
  const envPort = process.env['PORT'];
  const envDataDir = process.env['DATA_DIR'];
  const envDatabaseUrl = process.env['DATABASE_URL'];
  if (envPort || envDataDir || envDatabaseUrl) {
    if (!result.server) result.server = {};
    if (envPort) result.server.port = parseInt(envPort, 10);
    if (envDataDir) result.server.baseDir = envDataDir;
    if (envDatabaseUrl) result.server.databaseUrl = envDatabaseUrl;
  }

  // Embedding env overrides
  const envEmbeddingProvider = process.env['EMBEDDING_PROVIDER'];
  const envEmbeddingApiUrl = process.env['EMBEDDING_API_URL'];
  const envEmbeddingApiModel = process.env['EMBEDDING_API_MODEL'];
  if (envEmbeddingProvider || envEmbeddingApiUrl || envEmbeddingApiModel) {
    if (!result.embedding) result.embedding = {};
    if (envEmbeddingProvider) {
      result.embedding.provider = envEmbeddingProvider as 'hash' | 'api';
    }
    if (envEmbeddingApiUrl) result.embedding.apiUrl = envEmbeddingApiUrl;
    if (envEmbeddingApiModel) result.embedding.apiModel = envEmbeddingApiModel;
  }

  // Feishu connector env overrides
  const envFeishuEnabled = process.env['FEISHU_ENABLED'];
  const envFeishuAppId = process.env['FEISHU_APP_ID'];
  const envFeishuAppSecret = process.env['FEISHU_APP_SECRET'];
  const envFeishuBaseUrl = process.env['FEISHU_BASE_URL'];
  const envFeishuTimeoutMs = process.env['FEISHU_TIMEOUT_MS'];
  const envFeishuMaxRetries = process.env['FEISHU_MAX_RETRIES'];
  const envFeishuPollIntervalMs = process.env['FEISHU_POLL_INTERVAL_MS'];
  const envFeishuImEnabled = process.env['FEISHU_IM_ENABLED'];
  const envFeishuImVerifyToken = process.env['FEISHU_IM_VERIFY_TOKEN'];
  const envFeishuImDefaultOrgId = process.env['FEISHU_IM_DEFAULT_ORG_ID'];
  const envFeishuImDefaultUserId = process.env['FEISHU_IM_DEFAULT_USER_ID'];
  const envFeishuImDefaultProjectId = process.env['FEISHU_IM_DEFAULT_PROJECT_ID'];
  const envFeishuImAgentId = process.env['FEISHU_IM_AGENT_ID'];
  const envFeishuImSessionPrefix = process.env['FEISHU_IM_SESSION_PREFIX'];
  const envFeishuImWaitTimeoutMs = process.env['FEISHU_IM_WAIT_TIMEOUT_MS'];
  const envFeishuImPollIntervalMs = process.env['FEISHU_IM_POLL_INTERVAL_MS'];
  if (
    envFeishuEnabled !== undefined ||
    envFeishuAppId ||
    envFeishuAppSecret ||
    envFeishuBaseUrl ||
    envFeishuTimeoutMs ||
    envFeishuMaxRetries ||
    envFeishuPollIntervalMs ||
    envFeishuImEnabled !== undefined ||
    envFeishuImVerifyToken ||
    envFeishuImDefaultOrgId ||
    envFeishuImDefaultUserId ||
    envFeishuImDefaultProjectId ||
    envFeishuImAgentId ||
    envFeishuImSessionPrefix ||
    envFeishuImWaitTimeoutMs ||
    envFeishuImPollIntervalMs
  ) {
    if (!result.feishu) result.feishu = {};
    if (envFeishuEnabled !== undefined) {
      result.feishu.enabled = envFeishuEnabled === 'true';
    }
    if (envFeishuAppId) result.feishu.appId = envFeishuAppId;
    if (envFeishuAppSecret) result.feishu.appSecret = envFeishuAppSecret;
    if (envFeishuBaseUrl) result.feishu.baseUrl = envFeishuBaseUrl;
    if (envFeishuTimeoutMs) result.feishu.timeoutMs = parseInt(envFeishuTimeoutMs, 10);
    if (envFeishuMaxRetries) result.feishu.maxRetries = parseInt(envFeishuMaxRetries, 10);
    if (envFeishuPollIntervalMs) {
      result.feishu.pollIntervalMs = parseInt(envFeishuPollIntervalMs, 10);
    }
    if (
      envFeishuImEnabled !== undefined ||
      envFeishuImVerifyToken ||
      envFeishuImDefaultOrgId ||
      envFeishuImDefaultUserId ||
      envFeishuImDefaultProjectId ||
      envFeishuImAgentId ||
      envFeishuImSessionPrefix ||
      envFeishuImWaitTimeoutMs ||
      envFeishuImPollIntervalMs
    ) {
      if (!result.feishu.im) {
        result.feishu.im = {};
      }
      if (envFeishuImEnabled !== undefined) {
        result.feishu.im.enabled = envFeishuImEnabled === 'true';
      }
      if (envFeishuImVerifyToken) {
        result.feishu.im.verifyToken = envFeishuImVerifyToken;
      }
      if (envFeishuImDefaultOrgId) {
        result.feishu.im.defaultOrgId = envFeishuImDefaultOrgId;
      }
      if (envFeishuImDefaultUserId) {
        result.feishu.im.defaultUserId = envFeishuImDefaultUserId;
      }
      if (envFeishuImDefaultProjectId) {
        result.feishu.im.defaultProjectId = envFeishuImDefaultProjectId;
      }
      if (envFeishuImAgentId) {
        result.feishu.im.agentId = envFeishuImAgentId;
      }
      if (envFeishuImSessionPrefix) {
        result.feishu.im.sessionPrefix = envFeishuImSessionPrefix;
      }
      if (envFeishuImWaitTimeoutMs) {
        result.feishu.im.waitTimeoutMs = parseInt(envFeishuImWaitTimeoutMs, 10);
      }
      if (envFeishuImPollIntervalMs) {
        result.feishu.im.pollIntervalMs = parseInt(envFeishuImPollIntervalMs, 10);
      }
    }
  }

  // MinerU ingest env overrides
  const envMineruEnabled = process.env['MINERU_ENABLED'];
  const envMineruMode = process.env['MINERU_MODE'];
  const envMineruApiKey = process.env['MINERU_API_KEY'];
  const envMineruBaseUrl = process.env['MINERU_BASE_URL'];
  const envMineruUidToken = process.env['MINERU_UID_TOKEN'];
  const envMineruTimeoutMs = process.env['MINERU_TIMEOUT_MS'];
  const envMineruMaxRetries = process.env['MINERU_MAX_RETRIES'];
  const envMineruPollIntervalMs = process.env['MINERU_POLL_INTERVAL_MS'];
  const envMineruMaxPollAttempts = process.env['MINERU_MAX_POLL_ATTEMPTS'];
  const envMineruDefaultModelVersion = process.env['MINERU_DEFAULT_MODEL_VERSION'];
  if (
    envMineruEnabled !== undefined ||
    envMineruMode ||
    envMineruApiKey ||
    envMineruBaseUrl ||
    envMineruUidToken ||
    envMineruTimeoutMs ||
    envMineruMaxRetries ||
    envMineruPollIntervalMs ||
    envMineruMaxPollAttempts ||
    envMineruDefaultModelVersion
  ) {
    if (!result.mineru) result.mineru = {};
    if (envMineruEnabled !== undefined) {
      result.mineru.enabled = envMineruEnabled === 'true';
    }
    if (envMineruMode === 'v4') {
      result.mineru.mode = envMineruMode;
    }
    if (envMineruApiKey) result.mineru.apiKey = envMineruApiKey;
    if (envMineruBaseUrl) result.mineru.baseUrl = envMineruBaseUrl;
    if (envMineruUidToken) result.mineru.uidToken = envMineruUidToken;
    if (envMineruTimeoutMs) result.mineru.timeoutMs = parseInt(envMineruTimeoutMs, 10);
    if (envMineruMaxRetries) result.mineru.maxRetries = parseInt(envMineruMaxRetries, 10);
    if (envMineruPollIntervalMs) {
      result.mineru.pollIntervalMs = parseInt(envMineruPollIntervalMs, 10);
    }
    if (envMineruMaxPollAttempts) {
      result.mineru.maxPollAttempts = parseInt(envMineruMaxPollAttempts, 10);
    }
    if (envMineruDefaultModelVersion) {
      result.mineru.defaultModelVersion = envMineruDefaultModelVersion as
        'pipeline' | 'vlm' | 'MinerU-HTML';
    }
  }

  return result;
}

/**
 * Load and cache the agent configuration
 */
export async function loadConfig(dir: string = process.cwd()): Promise<AgentConfig> {
  if (cachedConfig) return cachedConfig;

  let fileConfig: AgentConfig;
  try {
    fileConfig = await loadConfigFile(dir);
  } catch (err) {
    logger.warn('Failed to load config file, using defaults', {
      error: err instanceof Error ? err.message : String(err),
    });
    fileConfig = {};
  }

  cachedConfig = applyEnvOverrides(fileConfig);
  return cachedConfig;
}

/**
 * Clear cached config (useful for testing)
 */
export function clearConfigCache(): void {
  cachedConfig = null;
}

/**
 * Convert an AgentConfig llm-like section to LLMConfig
 */
function toLLMConfigSection(
  llm: AgentConfig['llm'] | undefined
): LLMConfig | undefined {
  if (!llm || !llm.provider) return undefined;

  const result: LLMConfig = {
    provider: llm.provider,
    model: llm.model ?? (
      llm.provider === 'openai'
        ? 'gpt-4o'
        : llm.provider === 'gemini'
          ? 'gemini-3-pro-preview'
          : 'claude-sonnet-4-20250514'
    ),
  };
  if (llm.apiKey) result.apiKey = llm.apiKey;
  if (llm.baseUrl) result.baseUrl = llm.baseUrl;
  if (llm.temperature !== undefined) result.temperature = llm.temperature;
  if (llm.maxTokens !== undefined) result.maxTokens = llm.maxTokens;
  return result;
}

/**
 * Convert AgentConfig.llm to runtime LLMConfig
 */
export function toLLMConfig(config: AgentConfig): LLMConfig | undefined {
  return toLLMConfigSection(config.llm);
}

/**
 * Convert AgentConfig.planner.llm to runtime LLMConfig
 */
export function toPlannerLLMConfig(config: AgentConfig): LLMConfig | undefined {
  return toLLMConfigSection(config.planner?.llm as AgentConfig['llm'] | undefined);
}
