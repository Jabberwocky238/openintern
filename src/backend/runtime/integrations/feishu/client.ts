import { logger } from '@openintern/utils';

interface TenantTokenCache {
  value: string;
  expireAtMs: number;
}

interface FeishuClientRequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: Record<string, unknown>;
  requireAuth?: boolean;
  retryCount?: number;
}

export interface FeishuClientConfig {
  appId: string;
  appSecret: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface FeishuDriveFile {
  token: string;
  name: string;
  type: string;
  revision_id: string | null;
  url: string | null;
}

export interface FeishuDocxBlocksResponse {
  document_revision_id: string | null;
  items: Array<Record<string, unknown>>;
}

export interface FeishuBitableAppInfo {
  app_token: string;
  name: string;
  revision: number | null;
}

export interface FeishuBitableTableInfo {
  table_id: string;
  name: string;
  revision: number | null;
}

export type FeishuMessageReceiveIdType = 'open_id' | 'chat_id' | 'user_id' | 'email' | 'union_id';

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

export class FeishuApiError extends Error {
  constructor(
    message: string,
    public readonly details: {
      code?: number | null;
      httpStatus?: number;
      retryable: boolean;
    }
  ) {
    super(message);
    this.name = 'FeishuApiError';
  }
}

export class FeishuClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private tokenCache: TenantTokenCache | null = null;

  constructor(private readonly config: FeishuClientConfig) {
    this.baseUrl = (config.baseUrl ?? 'https://open.feishu.cn').replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? 20000;
    this.maxRetries = Math.max(0, Math.min(config.maxRetries ?? 3, 6));
  }

  async listFolderFiles(folderToken: string, pageSize: number = 200): Promise<FeishuDriveFile[]> {
    const result: FeishuDriveFile[] = [];
    let pageToken: string | undefined;

    for (;;) {
      const data = await this.request('GET', '/open-apis/drive/v1/files', {
        query: {
          folder_token: folderToken,
          page_size: pageSize,
          page_token: pageToken,
        },
      });
      const items = asArray(data['files'] ?? data['items']);
      for (const item of items) {
        const mapped = this.mapDriveFile(item);
        if (mapped) {
          result.push(mapped);
        }
      }

      const hasMore = Boolean(data['has_more']);
      pageToken = readString(data['next_page_token'] ?? data['page_token']) ?? undefined;
      if (!hasMore || !pageToken) {
        break;
      }
    }

    return result;
  }

  async getDriveFile(fileToken: string): Promise<FeishuDriveFile | null> {
    const data = await this.request('GET', `/open-apis/drive/v1/files/${encodeURIComponent(fileToken)}`);
    const mapped = this.mapDriveFile(data['file'] ?? data);
    return mapped;
  }

  async listDocxBlocks(
    documentId: string,
    documentRevisionId?: string
  ): Promise<FeishuDocxBlocksResponse> {
    const items: Array<Record<string, unknown>> = [];
    let pageToken: string | undefined;
    let revisionId: string | null = documentRevisionId ?? null;

    for (;;) {
      const data = await this.request(
        'GET',
        `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks`,
        {
          query: {
            page_size: 500,
            page_token: pageToken,
            document_revision_id: documentRevisionId,
          },
        }
      );

      const blockItems = asArray(data['items']);
      for (const block of blockItems) {
        items.push(asRecord(block));
      }

      revisionId = readString(data['document_revision_id']) ?? revisionId;
      const hasMore = Boolean(data['has_more']);
      pageToken = readString(data['page_token'] ?? data['next_page_token']) ?? undefined;
      if (!hasMore || !pageToken) {
        break;
      }
    }

    return {
      document_revision_id: revisionId,
      items,
    };
  }

  async getDocxRawContent(documentId: string): Promise<string | null> {
    const data = await this.request(
      'GET',
      `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`
    );
    return (
      readString(data['content']) ??
      readString(data['raw_content']) ??
      readString(data['text']) ??
      null
    );
  }

  async getBitableApp(appToken: string): Promise<FeishuBitableAppInfo | null> {
    const data = await this.request('GET', `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}`);
    const app = asRecord(data['app'] ?? data);
    const token = readString(app['app_token']) ?? appToken;
    const name = readString(app['name']) ?? token;
    const revision = readNumber(app['revision']);
    return {
      app_token: token,
      name,
      revision,
    };
  }

  async listBitableTables(appToken: string): Promise<FeishuBitableTableInfo[]> {
    const result: FeishuBitableTableInfo[] = [];
    let pageToken: string | undefined;
    for (;;) {
      const data = await this.request(
        'GET',
        `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`,
        {
          query: {
            page_size: 100,
            page_token: pageToken,
          },
        }
      );
      const items = asArray(data['items'] ?? data['tables']);
      for (const table of items) {
        const record = asRecord(table);
        const tableId = readString(record['table_id']);
        if (!tableId) {
          continue;
        }
        result.push({
          table_id: tableId,
          name: readString(record['name']) ?? tableId,
          revision: readNumber(record['revision']),
        });
      }
      const hasMore = Boolean(data['has_more']);
      pageToken = readString(data['page_token'] ?? data['next_page_token']) ?? undefined;
      if (!hasMore || !pageToken) {
        break;
      }
    }
    return result;
  }

  async listBitableFields(
    appToken: string,
    tableId: string
  ): Promise<Array<Record<string, unknown>>> {
    const result: Array<Record<string, unknown>> = [];
    let pageToken: string | undefined;
    for (;;) {
      const data = await this.request(
        'GET',
        `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields`,
        {
          query: {
            page_size: 200,
            page_token: pageToken,
          },
        }
      );
      const items = asArray(data['items']);
      for (const field of items) {
        result.push(asRecord(field));
      }
      const hasMore = Boolean(data['has_more']);
      pageToken = readString(data['page_token'] ?? data['next_page_token']) ?? undefined;
      if (!hasMore || !pageToken) {
        break;
      }
    }
    return result;
  }

  async searchBitableRecords(
    appToken: string,
    tableId: string,
    maxRecords: number
  ): Promise<Array<Record<string, unknown>>> {
    const result: Array<Record<string, unknown>> = [];
    let pageToken: string | undefined;
    const pageSize = Math.max(1, Math.min(500, maxRecords));

    for (;;) {
      let data: Record<string, unknown>;
      try {
        data = await this.request(
          'POST',
          `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/search`,
          {
            body: {
              page_size: pageSize,
              ...(pageToken ? { page_token: pageToken } : {}),
            },
          }
        );
      } catch (error) {
        if (result.length > 0) {
          break;
        }
        logger.warn('records/search failed, fallback to records list', {
          appToken,
          tableId,
          error: error instanceof Error ? error.message : String(error),
        });
        data = await this.request(
          'GET',
          `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`,
          {
            query: {
              page_size: pageSize,
              page_token: pageToken,
            },
          }
        );
      }

      const items = asArray(data['items']);
      for (const item of items) {
        result.push(asRecord(item));
        if (result.length >= maxRecords) {
          return result;
        }
      }

      const hasMore = Boolean(data['has_more']);
      pageToken = readString(data['page_token'] ?? data['next_page_token']) ?? undefined;
      if (!hasMore || !pageToken) {
        break;
      }
    }

    return result;
  }

  async sendTextMessage(args: {
    receiveIdType: FeishuMessageReceiveIdType;
    receiveId: string;
    text: string;
  }): Promise<void> {
    await this.request('POST', '/open-apis/im/v1/messages', {
      query: { receive_id_type: args.receiveIdType },
      body: {
        receive_id: args.receiveId,
        msg_type: 'text',
        content: JSON.stringify({ text: args.text }),
      },
    });
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    options: FeishuClientRequestOptions = {}
  ): Promise<Record<string, unknown>> {
    const retries = Math.max(0, Math.min(options.retryCount ?? this.maxRetries, 6));
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const token = options.requireAuth === false ? null : await this.getTenantAccessToken();
        const data = await this.doRequest(method, path, options, token);
        return data;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        lastError = err;

        const retryable = err instanceof FeishuApiError ? err.details.retryable : true;
        if (!retryable || attempt >= retries) {
          break;
        }

        const delay = Math.min(3000, 200 * 2 ** attempt);
        await sleep(delay);
      }
    }

    throw lastError ?? new Error('Feishu request failed');
  }

  private async doRequest(
    method: 'GET' | 'POST',
    path: string,
    options: FeishuClientRequestOptions,
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
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(method === 'POST' ? { body: JSON.stringify(options.body ?? {}) } : {}),
        signal: controller.signal,
      });

      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        throw new FeishuApiError(
          `Feishu HTTP ${response.status}`,
          {
            code: readNumber(payload['code']),
            httpStatus: response.status,
            retryable: isRetryableStatus(response.status),
          }
        );
      }

      const code = readNumber(payload['code']) ?? 0;
      if (code !== 0) {
        throw new FeishuApiError(
          `Feishu API error: ${readString(payload['msg']) ?? 'unknown error'}`,
          {
            code,
            httpStatus: response.status,
            retryable: code === 99991663 || code === 11232 || code === 90001,
          }
        );
      }

      return asRecord(payload['data'] ?? payload);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private async getTenantAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && now < this.tokenCache.expireAtMs - 60000) {
      return this.tokenCache.value;
    }

    const data = await this.doRequest(
      'POST',
      '/open-apis/auth/v3/tenant_access_token/internal',
      {
        requireAuth: false,
        body: {
          app_id: this.config.appId,
          app_secret: this.config.appSecret,
        },
      },
      null
    );

    const token = readString(data['tenant_access_token']);
    if (!token) {
      throw new FeishuApiError('tenant_access_token missing in response', {
        retryable: false,
      });
    }
    const expireSeconds = readNumber(data['expire']) ?? 7200;
    this.tokenCache = {
      value: token,
      expireAtMs: now + expireSeconds * 1000,
    };
    return token;
  }

  private mapDriveFile(value: unknown): FeishuDriveFile | null {
    const data = asRecord(value);
    const token = readString(data['token'] ?? data['file_token'] ?? data['obj_token']);
    if (!token) {
      return null;
    }
    const type =
      readString(data['type']) ??
      readString(data['file_type']) ??
      readString(data['mime_type']) ??
      'unknown';
    return {
      token,
      name: readString(data['name']) ?? token,
      type,
      revision_id: readString(data['revision_id']),
      url: readString(data['url'] ?? data['link']),
    };
  }
}

