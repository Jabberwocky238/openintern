/**
 * Config Loader tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadConfig, clearConfigCache, toLLMConfig } from './loader.js';
import type { AgentConfig } from '../types/agent.js';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
}));

const mockExistsSync = vi.mocked(existsSync);
const mockReadFile = vi.mocked(readFile);

const ENV_KEYS = [
  'LLM_PROVIDER', 'LLM_MODEL', 'LLM_BASE_URL', 'LLM_API_KEY',
  'LLM_TEMPERATURE', 'LLM_MAX_TOKENS',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL',
  'PORT', 'DATA_DIR',
  'FEISHU_ENABLED', 'FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_BASE_URL',
  'FEISHU_TIMEOUT_MS', 'FEISHU_MAX_RETRIES', 'FEISHU_POLL_INTERVAL_MS',
  'FEISHU_IM_ENABLED', 'FEISHU_IM_VERIFY_TOKEN', 'FEISHU_IM_DEFAULT_ORG_ID',
  'FEISHU_IM_DEFAULT_USER_ID', 'FEISHU_IM_DEFAULT_PROJECT_ID', 'FEISHU_IM_AGENT_ID',
  'FEISHU_IM_SESSION_PREFIX', 'FEISHU_IM_WAIT_TIMEOUT_MS', 'FEISHU_IM_POLL_INTERVAL_MS',
  'MINERU_ENABLED', 'MINERU_MODE', 'MINERU_API_KEY', 'MINERU_BASE_URL', 'MINERU_UID_TOKEN',
  'MINERU_TIMEOUT_MS', 'MINERU_MAX_RETRIES', 'MINERU_POLL_INTERVAL_MS',
  'MINERU_MAX_POLL_ATTEMPTS', 'MINERU_DEFAULT_MODEL_VERSION',
];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  clearConfigCache();
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  mockExistsSync.mockReturnValue(false);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key];
    } else {
      delete process.env[key];
    }
  }
});

describe('loadConfig', () => {
  it('should return empty config when no file and no env vars', async () => {
    const config = await loadConfig('/tmp/test');
    expect(config).toEqual({});
  });

  it('should load JSON config file', async () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith('agent.config.json')
    );
    const fileContent: AgentConfig = {
      llm: { provider: 'openai', model: 'gpt-4o', baseUrl: 'https://custom.api/v1' },
      server: { port: 8080 },
    };
    mockReadFile.mockResolvedValue(JSON.stringify(fileContent));

    const config = await loadConfig('/tmp/test');

    expect(config.llm?.provider).toBe('openai');
    expect(config.llm?.model).toBe('gpt-4o');
    expect(config.llm?.baseUrl).toBe('https://custom.api/v1');
    expect(config.server?.port).toBe(8080);
  });

  it('should apply LLM env var overrides', async () => {
    process.env['LLM_PROVIDER'] = 'anthropic';
    process.env['LLM_MODEL'] = 'claude-3-opus';
    process.env['LLM_BASE_URL'] = 'https://my-proxy/v1';
    process.env['LLM_TEMPERATURE'] = '0.5';

    const config = await loadConfig('/tmp/test');

    expect(config.llm?.provider).toBe('anthropic');
    expect(config.llm?.model).toBe('claude-3-opus');
    expect(config.llm?.baseUrl).toBe('https://my-proxy/v1');
    expect(config.llm?.temperature).toBe(0.5);
  });

  it('should apply server env var overrides', async () => {
    process.env['PORT'] = '9090';
    process.env['DATA_DIR'] = '/custom/data';

    const config = await loadConfig('/tmp/test');

    expect(config.server?.port).toBe(9090);
    expect(config.server?.baseDir).toBe('/custom/data');
  });

  it('should apply Feishu env var overrides', async () => {
    process.env['FEISHU_ENABLED'] = 'true';
    process.env['FEISHU_APP_ID'] = 'cli_app_id';
    process.env['FEISHU_APP_SECRET'] = 'cli_app_secret';
    process.env['FEISHU_POLL_INTERVAL_MS'] = '180000';
    process.env['FEISHU_IM_ENABLED'] = 'true';
    process.env['FEISHU_IM_VERIFY_TOKEN'] = 'token_123';
    process.env['FEISHU_IM_DEFAULT_ORG_ID'] = 'org_feishu';
    process.env['FEISHU_IM_DEFAULT_PROJECT_ID'] = 'proj_feishu';
    process.env['FEISHU_IM_AGENT_ID'] = 'main';
    process.env['FEISHU_IM_SESSION_PREFIX'] = 's_feishu';
    process.env['FEISHU_IM_WAIT_TIMEOUT_MS'] = '80000';
    process.env['FEISHU_IM_POLL_INTERVAL_MS'] = '700';

    const config = await loadConfig('/tmp/test');

    expect(config.feishu?.enabled).toBe(true);
    expect(config.feishu?.appId).toBe('cli_app_id');
    expect(config.feishu?.appSecret).toBe('cli_app_secret');
    expect(config.feishu?.pollIntervalMs).toBe(180000);
    expect(config.feishu?.im?.enabled).toBe(true);
    expect(config.feishu?.im?.verifyToken).toBe('token_123');
    expect(config.feishu?.im?.defaultOrgId).toBe('org_feishu');
    expect(config.feishu?.im?.defaultProjectId).toBe('proj_feishu');
    expect(config.feishu?.im?.agentId).toBe('main');
    expect(config.feishu?.im?.sessionPrefix).toBe('s_feishu');
    expect(config.feishu?.im?.waitTimeoutMs).toBe(80000);
    expect(config.feishu?.im?.pollIntervalMs).toBe(700);
  });

  it('should apply MinerU env var overrides', async () => {
    process.env['MINERU_ENABLED'] = 'true';
    process.env['MINERU_MODE'] = 'v4';
    process.env['MINERU_API_KEY'] = 'ak_test_key';
    process.env['MINERU_POLL_INTERVAL_MS'] = '4500';
    process.env['MINERU_MAX_POLL_ATTEMPTS'] = '80';
    process.env['MINERU_DEFAULT_MODEL_VERSION'] = 'vlm';

    const config = await loadConfig('/tmp/test');

    expect(config.mineru?.enabled).toBe(true);
    expect(config.mineru?.mode).toBe('v4');
    expect(config.mineru?.apiKey).toBe('ak_test_key');
    expect(config.mineru?.pollIntervalMs).toBe(4500);
    expect(config.mineru?.maxPollAttempts).toBe(80);
    expect(config.mineru?.defaultModelVersion).toBe('vlm');
  });

  it('should auto-detect from OPENAI_API_KEY', async () => {
    process.env['OPENAI_API_KEY'] = 'sk-test';

    const config = await loadConfig('/tmp/test');

    expect(config.llm?.provider).toBe('openai');
    expect(config.llm?.apiKey).toBe('sk-test');
    expect(config.llm?.model).toBe('gpt-4o');
  });

  it('should auto-detect from ANTHROPIC_API_KEY', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';

    const config = await loadConfig('/tmp/test');

    expect(config.llm?.provider).toBe('anthropic');
    expect(config.llm?.apiKey).toBe('sk-ant-test');
    expect(config.llm?.model).toBe('claude-sonnet-4-20250514');
  });

  it('should support Anthropic compatibility base URL env vars', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
    process.env['ANTHROPIC_BASE_URL'] = 'https://api.minimaxi.com/anthropic';

    const config = await loadConfig('/tmp/test');

    expect(config.llm?.provider).toBe('anthropic');
    expect(config.llm?.apiKey).toBe('sk-ant-test');
    expect(config.llm?.baseUrl).toBe('https://api.minimaxi.com/anthropic');
  });

  it('should let env vars override file config', async () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith('agent.config.json')
    );
    const fileContent: AgentConfig = {
      llm: { provider: 'openai', model: 'gpt-4o' },
    };
    mockReadFile.mockResolvedValue(JSON.stringify(fileContent));

    process.env['LLM_MODEL'] = 'gpt-4-turbo';

    const config = await loadConfig('/tmp/test');

    expect(config.llm?.provider).toBe('openai');
    expect(config.llm?.model).toBe('gpt-4-turbo');
  });

  it('should cache config after first load', async () => {
    const config1 = await loadConfig('/tmp/test');
    process.env['LLM_PROVIDER'] = 'anthropic';
    const config2 = await loadConfig('/tmp/test');

    expect(config1).toBe(config2);
  });
});

describe('toLLMConfig', () => {
  it('should return undefined when no llm config', () => {
    expect(toLLMConfig({})).toBeUndefined();
  });

  it('should return undefined when no provider', () => {
    expect(toLLMConfig({ llm: { model: 'gpt-4o' } })).toBeUndefined();
  });

  it('should convert AgentConfig.llm to LLMConfig', () => {
    const config: AgentConfig = {
      llm: {
        provider: 'openai',
        model: 'gpt-4o',
        baseUrl: 'https://custom.api/v1',
        apiKey: 'sk-test',
        temperature: 0.5,
        maxTokens: 4000,
      },
    };

    const result = toLLMConfig(config);

    expect(result).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
      baseUrl: 'https://custom.api/v1',
      apiKey: 'sk-test',
      temperature: 0.5,
      maxTokens: 4000,
    });
  });

  it('should use default model for provider', () => {
    const result = toLLMConfig({ llm: { provider: 'anthropic' } });

    expect(result?.provider).toBe('anthropic');
    expect(result?.model).toBe('claude-sonnet-4-20250514');
  });

  it('should use default model for gemini provider', () => {
    const result = toLLMConfig({ llm: { provider: 'gemini' } });

    expect(result?.provider).toBe('gemini');
    expect(result?.model).toBe('gemini-3-pro-preview');
  });
});
