import { promises as fs } from 'node:fs';
import { logger } from '../../../../utils/logger.js';
import type { MineruExtractOptions, MineruModelVersion, MineruTaskState } from '../../../../types/mineru.js';

interface MineruTokenCache {
  value: string;
  expireAtMs: number;
}

interface MineruRequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: Record<string, unknown>;
  retryCount?: number;
}

export type MineruClientMode = 'v4';

export interface MineruClientConfig {
  mode?: MineruClientMode;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  uidToken?: string;
}

export interface MineruCreateTaskInput {
  fileUrl: string;
  options?: MineruExtractOptions;
}

export interface MineruTaskInfo {
  task_id: string;
  data_id: string | null;
  state: MineruTaskState;
  err_msg: string | null;
  full_zip_url: string | null;
  output_path: string | null;
}

export interface MineruWaitTaskOptions {
  intervalMs: number;
  maxAttempts: number;
}

export interface MineruBatchUploadFileInput {
  name: string;
  data_id?: string;
  is_ocr?: boolean;
  page_ranges?: string;
}

export interface MineruCreateBatchUploadInput {
  files: MineruBatchUploadFileInput[];
  options?: MineruExtractOptions;
}

export interface MineruBatchUploadResult {
  batch_id: string;
  file_urls: string[];
}

export type MineruBatchTaskState = MineruTaskState | 'waiting-file';

export interface MineruBatchExtractResultItem {
  file_name: string | null;
  state: MineruBatchTaskState;
  err_msg: string | null;
  full_zip_url: string | null;
  data_id: string | null;
  extract_progress: Record<string, unknown> | null;
}

export interface MineruBatchExtractResult {
  batch_id: string;
  extract_result: MineruBatchExtractResultItem[];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function normalizeTaskState(value: string | null): MineruTaskState {
  const normalized = (value ?? '').toLowerCase();
  if (
    normalized === 'pending' ||
    normalized === 'running' ||
    normalized === 'converting' ||
    normalized === 'done' ||
    normalized === 'failed'
  ) {
    return normalized;
  }
  if (normalized === 'success' || normalized === 'completed') {
    return 'done';
  }
  if (normalized === 'error') {
    return 'failed';
  }
  return 'running';
}

function normalizeBatchTaskState(value: string | null): MineruBatchTaskState {
  const normalized = (value ?? '').toLowerCase();
  if (normalized === 'waiting-file') {
    return 'waiting-file';
  }
  return normalizeTaskState(value);
}

export class MineruApiError extends Error {
  constructor(
    message: string,
    public readonly details: {
      code?: number | null;
      httpStatus?: number;
      retryable: boolean;
    }
  ) {
    super(message);
    this.name = 'MineruApiError';
  }
}

export class MineruClient {
  private readonly mode: MineruClientMode;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly uidToken: string | null;
  private readonly apiKey: string | null;
  private readonly directApiTokenMode: boolean;
  private tokenCache: MineruTokenCache | null = null;

  constructor(private readonly config: MineruClientConfig) {
    this.mode = 'v4';
    this.baseUrl = (config.baseUrl ?? 'https://mineru.net/api/v4').replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? 20000;
    this.maxRetries = Math.max(0, Math.min(config.maxRetries ?? 3, 6));
    this.uidToken = readString(config.uidToken);
    this.apiKey = readString(config.apiKey);
    if (!this.apiKey) {
      throw new Error('apiKey is required for MinerU v4');
    }
    this.directApiTokenMode =
      !this.apiKey.startsWith('ak_') &&
      !this.apiKey.startsWith('ak-') &&
      !this.apiKey.startsWith('sk_') &&
      !this.apiKey.startsWith('sk-') &&
      this.apiKey.includes('.');
  }

  getMode(): MineruClientMode {
    return this.mode;
  }

  async createExtractTask(input: MineruCreateTaskInput): Promise<MineruTaskInfo> {
    const options = input.options ?? {};
    const modelVersion = options.model_version ?? 'pipeline';
    const body: Record<string, unknown> = {
      url: input.fileUrl,
      model_version: modelVersion as MineruModelVersion,
      is_ocr: options.is_ocr ?? false,
      enable_formula: options.enable_formula ?? true,
      enable_table: options.enable_table ?? true,
      ...(options.language ? { language: options.language } : {}),
      ...(options.page_ranges ? { page_ranges: options.page_ranges } : {}),
      ...(options.no_cache !== undefined ? { no_cache: options.no_cache } : {}),
      ...(options.cache_tolerance !== undefined
        ? { cache_tolerance: options.cache_tolerance }
        : {}),
      ...(options.data_id ? { data_id: options.data_id } : {}),
    };
    const data = await this.request('POST', '/extract/task', { body });
    const task = asRecord(data['task'] ?? data);
    return this.mapTask(task);
  }

  async getExtractTask(taskId: string): Promise<MineruTaskInfo> {
    const data = await this.request(
      'GET',
      `/extract/task/${encodeURIComponent(taskId)}`
    );
    const task = asRecord(data['task'] ?? data);
    return this.mapTask(task);
  }

  async waitForTask(taskId: string, options: MineruWaitTaskOptions): Promise<MineruTaskInfo> {
    const attempts = Math.max(1, options.maxAttempts);
    const intervalMs = Math.max(1000, options.intervalMs);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const task = await this.getExtractTask(taskId);
      if (task.state === 'done') {
        return task;
      }
      if (task.state === 'failed') {
        throw new MineruApiError(
          task.err_msg ?? 'MinerU task failed',
          { retryable: false }
        );
      }
      await sleep(intervalMs);
    }
    throw new MineruApiError(
      `MinerU task timeout after ${attempts} attempts`,
      { retryable: false }
    );
  }

  async createBatchUpload(input: MineruCreateBatchUploadInput): Promise<MineruBatchUploadResult> {
    if (input.files.length === 0) {
      throw new MineruApiError('files is required', { retryable: false });
    }
    const options = input.options ?? {};
    const body: Record<string, unknown> = {
      files: input.files.map((item) => ({
        name: item.name,
        ...(item.data_id ? { data_id: item.data_id } : {}),
        ...(item.is_ocr !== undefined ? { is_ocr: item.is_ocr } : {}),
        ...(item.page_ranges ? { page_ranges: item.page_ranges } : {}),
      })),
      model_version: options.model_version ?? 'pipeline',
      ...(options.enable_formula !== undefined ? { enable_formula: options.enable_formula } : {}),
      ...(options.enable_table !== undefined ? { enable_table: options.enable_table } : {}),
      ...(options.language ? { language: options.language } : {}),
      ...(options.data_id ? { data_id: options.data_id } : {}),
      ...(options.page_ranges ? { page_ranges: options.page_ranges } : {}),
    };
    const data = await this.request('POST', '/file-urls/batch', { body });
    const batchId = readString(data['batch_id']);
    const fileUrls = asArray(data['file_urls'])
      .map((item) => readString(item))
      .filter((item): item is string => item !== null);
    if (!batchId) {
      throw new MineruApiError('batch_id missing in MinerU batch upload response', {
        retryable: false,
      });
    }
    if (fileUrls.length === 0) {
      throw new MineruApiError('file_urls missing in MinerU batch upload response', {
        retryable: false,
      });
    }
    return {
      batch_id: batchId,
      file_urls: fileUrls,
    };
  }

  async uploadFileToSignedUrl(url: string, filePath: string): Promise<void> {
    const bytes = await fs.readFile(filePath);
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'PUT',
        body: bytes,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new MineruApiError(
          `MinerU signed upload HTTP ${response.status}`,
          {
            httpStatus: response.status,
            retryable: isRetryableStatus(response.status),
          }
        );
      }
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  async getBatchExtractResult(batchId: string): Promise<MineruBatchExtractResult> {
    const data = await this.request(
      'GET',
      `/extract-results/batch/${encodeURIComponent(batchId)}`
    );
    const extractResults = asArray(data['extract_result'])
      .map((item) => this.mapBatchExtractItem(asRecord(item)));
    return {
      batch_id: readString(data['batch_id']) ?? batchId,
      extract_result: extractResults,
    };
  }

  async waitForBatchResult(
    batchId: string,
    options: MineruWaitTaskOptions & {
      dataId?: string | null;
      fileName?: string | null;
    }
  ): Promise<MineruBatchExtractResultItem> {
    const attempts = Math.max(1, options.maxAttempts);
    const intervalMs = Math.max(1000, options.intervalMs);
    const targetDataId = readString(options.dataId ?? null);
    const targetFileName = readString(options.fileName ?? null);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const result = await this.getBatchExtractResult(batchId);
      const item =
        result.extract_result.find((candidate) => {
          if (targetDataId && candidate.data_id === targetDataId) {
            return true;
          }
          if (targetFileName && candidate.file_name === targetFileName) {
            return true;
          }
          return false;
        }) ??
        result.extract_result[0] ??
        null;
      if (!item) {
        await sleep(intervalMs);
        continue;
      }
      if (item.state === 'done') {
        return item;
      }
      if (item.state === 'failed') {
        throw new MineruApiError(item.err_msg ?? 'MinerU batch task failed', {
          retryable: false,
        });
      }
      await sleep(intervalMs);
    }
    throw new MineruApiError(
      `MinerU batch task timeout after ${attempts} attempts`,
      { retryable: false }
    );
  }

  async downloadFile(url: string): Promise<Buffer> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new MineruApiError(
          `MinerU file download HTTP ${response.status}`,
          {
            httpStatus: response.status,
            retryable: isRetryableStatus(response.status),
          }
        );
      }
      const bytes = await response.arrayBuffer();
      return Buffer.from(bytes);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    options: MineruRequestOptions = {}
  ): Promise<Record<string, unknown>> {
    const retries = Math.max(0, Math.min(options.retryCount ?? this.maxRetries, 6));
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const token = this.directApiTokenMode
          ? this.requireApiKey()
          : await this.getApiToken();
        const data = await this.doRequest(method, path, options, token);
        return data;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        lastError = err;
        const retryable = err instanceof MineruApiError ? err.details.retryable : true;
        if (!retryable || attempt >= retries) {
          break;
        }
        const delay = Math.min(3000, 200 * 2 ** attempt);
        await sleep(delay);
      }
    }

    throw lastError ?? new Error('MinerU request failed');
  }

  private async doRequest(
    method: 'GET' | 'POST',
    path: string,
    options: MineruRequestOptions,
    token: string | null
  ): Promise<Record<string, unknown>> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined) {
        continue;
      }
      url.searchParams.set(key, String(value));
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(this.uidToken ? { token: this.uidToken } : {}),
        },
        ...(method === 'POST' ? { body: JSON.stringify(options.body ?? {}) } : {}),
        signal: controller.signal,
      });

      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        throw new MineruApiError(
          `MinerU HTTP ${response.status}`,
          {
            code: readNumber(payload['code']),
            httpStatus: response.status,
            retryable: isRetryableStatus(response.status),
          }
        );
      }

      const code = readNumber(payload['code']) ?? 0;
      if (code !== 0) {
        throw new MineruApiError(
          `MinerU API error: ${readString(payload['msg']) ?? 'unknown error'}`,
          {
            code,
            httpStatus: response.status,
            retryable: code === 429 || code >= 500,
          }
        );
      }

      return asRecord(payload['data'] ?? payload);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private async getApiToken(): Promise<string> {
    const apiKey = this.requireApiKey();
    const now = Date.now();
    if (this.tokenCache && now < this.tokenCache.expireAtMs - 60000) {
      return this.tokenCache.value;
    }

    const path = apiKey.startsWith('sk-')
      ? '/token/get_token_by_sk'
      : '/token/get_token';
    const body = apiKey.startsWith('sk-')
      ? { sk: apiKey }
      : { ak: apiKey };
    const data = await this.doRequest('POST', path, { body }, null);

    const token = readString(data['token']);
    if (!token) {
      throw new MineruApiError('token missing in response', {
        retryable: false,
      });
    }
    const expireSeconds = readNumber(data['expired']) ?? 7200;
    this.tokenCache = {
      value: token,
      expireAtMs: now + expireSeconds * 1000,
    };
    logger.debug('MinerU API token refreshed', { expireSeconds });
    return token;
  }

  private mapTask(value: Record<string, unknown>): MineruTaskInfo {
    const taskId = readString(value['task_id']) ?? '';
    if (!taskId) {
      throw new MineruApiError('task_id missing in MinerU task payload', {
        retryable: false,
      });
    }
    return {
      task_id: taskId,
      data_id: readString(value['data_id']),
      state: normalizeTaskState(readString(value['state'])),
      err_msg: readString(value['err_msg']),
      full_zip_url: readString(value['full_zip_url']),
      output_path: readString(value['output_path']),
    };
  }

  private mapBatchExtractItem(value: Record<string, unknown>): MineruBatchExtractResultItem {
    const extractProgressRaw = value['extract_progress'];
    return {
      file_name: readString(value['file_name']),
      state: normalizeBatchTaskState(readString(value['state'])),
      err_msg: readString(value['err_msg']),
      full_zip_url: readString(value['full_zip_url']),
      data_id: readString(value['data_id']),
      extract_progress:
        extractProgressRaw && typeof extractProgressRaw === 'object'
          ? asRecord(extractProgressRaw)
          : null,
    };
  }

  private requireApiKey(): string {
    const apiKey = readString(this.apiKey);
    if (!apiKey) {
      throw new MineruApiError('apiKey is required for MinerU v4', {
        retryable: false,
      });
    }
    return apiKey;
  }
}

