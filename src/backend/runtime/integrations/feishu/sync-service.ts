import { logger } from '@openintern/utils';
import type { MemoryScope } from '../../../../types/memory.js';
import {
  FeishuChunkingConfigSchema,
  type FeishuChunkingConfig,
  type FeishuConnector,
  type FeishuSyncJob,
  type FeishuSyncStats,
} from '../../../../types/feishu.js';
import { AgentError } from '../../../../utils/errors.js';
import { FeishuClient } from './client.js';
import { normalizeBitableTableToChunks, normalizeDocxToChunks } from './normalizer.js';
import type { IFeishuRepository } from '@openintern/repository';
import { MemoryService } from '../../memory-service.js';

interface SyncSourceDocx {
  kind: 'docx';
  file_token: string;
  document_id: string;
  title: string;
  revision_id: string | null;
}

interface SyncSourceBitable {
  kind: 'bitable';
  file_token: string | null;
  app_token: string;
  title: string;
  revision_id: string | null;
}

type SyncSource = SyncSourceDocx | SyncSourceBitable;

export interface FeishuSyncServiceConfig {
  enabled: boolean;
  pollIntervalMs?: number;
}

export interface FeishuIngestDocInput {
  scope: {
    orgId: string;
    userId: string;
    projectId: string | null;
  };
  doc_token?: string;
  doc_url?: string;
  title?: string;
  source_key?: string;
  chunking?: Partial<FeishuChunkingConfig>;
  project_shared?: boolean;
  metadata?: Record<string, unknown>;
}

export interface FeishuIngestDocResult {
  memory_id: string;
  source_key: string;
  document_id: string;
  revision_id: string | null;
  title: string;
  chunk_count: number;
  content_hash: string;
  replaced: number;
}

const FEISHU_DOC_URL_SEGMENTS = new Set(['docx', 'doc', 'docs', 'wiki']);

function readString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isHttpUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

function extractDocTokenFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const segments = parsed.pathname
    .split('/')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (segments.length === 0) {
    return null;
  }

  for (let i = 0; i < segments.length; i++) {
    const current = segments[i];
    if (!current) {
      continue;
    }
    if (!FEISHU_DOC_URL_SEGMENTS.has(current.toLowerCase())) {
      continue;
    }
    const next = segments[i + 1];
    if (next) {
      return next;
    }
  }

  return segments[segments.length - 1] ?? null;
}

function emptyStats(): FeishuSyncStats {
  return {
    discovered: 0,
    processed: 0,
    skipped: 0,
    failed: 0,
    docx_docs: 0,
    bitable_tables: 0,
    chunk_count: 0,
  };
}

function normalizeType(type: string): string {
  return type.trim().toLowerCase();
}

function isDocxType(type: string): boolean {
  const normalized = normalizeType(type);
  return normalized.includes('docx') || normalized === 'doc' || normalized.includes('document');
}

function isBitableType(type: string): boolean {
  const normalized = normalizeType(type);
  return normalized.includes('bitable') || normalized.includes('base');
}

export class FeishuSyncService {
  private readonly enabled: boolean;
  private readonly pollIntervalMs: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private pollRunning = false;
  private readonly runningConnectorIds = new Set<string>();

  constructor(
    private readonly repository: IFeishuRepository,
    private readonly memoryService: MemoryService,
    private readonly client: FeishuClient | null,
    config: FeishuSyncServiceConfig
  ) {
    this.enabled = config.enabled;
    this.pollIntervalMs = Math.max(60000, config.pollIntervalMs ?? 120000);
  }

  isEnabled(): boolean {
    return this.enabled && this.client !== null;
  }

  async ingestDoc(input: FeishuIngestDocInput): Promise<FeishuIngestDocResult> {
    if (!this.isEnabled()) {
      throw new AgentError(
        'Feishu sync is disabled. Configure feishu.appId / feishu.appSecret first.',
        'FEISHU_SYNC_DISABLED',
        400
      );
    }

    let documentId = readString(input.doc_token);
    if (documentId && isHttpUrl(documentId)) {
      documentId = extractDocTokenFromUrl(documentId);
    }
    if (!documentId) {
      const docUrl = readString(input.doc_url);
      if (!docUrl) {
        throw new AgentError('doc_token or doc_url is required', 'FEISHU_DOC_TOKEN_REQUIRED', 400);
      }
      documentId = extractDocTokenFromUrl(docUrl);
      if (!documentId) {
        throw new AgentError('Invalid Feishu doc_url', 'FEISHU_DOC_URL_INVALID', 400);
      }
    }

    const chunkingParsed = FeishuChunkingConfigSchema.safeParse(input.chunking ?? {});
    if (!chunkingParsed.success) {
      const first = chunkingParsed.error.errors[0];
      throw new AgentError(first?.message ?? 'Invalid chunking config', 'FEISHU_CHUNKING_INVALID', 400);
    }
    const chunking = chunkingParsed.data;

    const client = this.requireClient();
    const file = await client.getDriveFile(documentId).catch(() => null);
    const blocks = await client.listDocxBlocks(documentId);
    const rawContent = await client.getDocxRawContent(documentId).catch(() => null);

    const title =
      readString(input.title) ??
      file?.name ??
      documentId;
    const normalized = normalizeDocxToChunks({
      title,
      blocks: blocks.items,
      rawContent,
      chunking,
    });
    const revisionId = blocks.document_revision_id ?? file?.revision_id ?? null;
    const sourceKey = readString(input.source_key) ?? `docx:${documentId}`;

    const scope: MemoryScope = {
      org_id: input.scope.orgId,
      user_id: input.scope.userId,
      ...(input.scope.projectId ? { project_id: input.scope.projectId } : {}),
    };
    const projectShared = input.project_shared ?? Boolean(input.scope.projectId);

    const write = await this.memoryService.replace_archival_document({
      scope,
      source: {
        source_type: 'feishu_docx',
        source_key: sourceKey,
      },
      text: normalized.text,
      metadata: {
        ...(input.metadata ?? {}),
        file_token: file?.token ?? documentId,
        document_id: documentId,
        title,
        revision_id: revisionId,
        ...(input.doc_url ? { source_url: input.doc_url } : {}),
      },
      chunks: normalized.chunks.map((chunk) => ({
        text: chunk.text,
        snippet: chunk.snippet,
        metadata: {
          source_type: 'feishu_docx',
          chunk_type: chunk.chunk_type,
          title_path: chunk.title_path,
          block_ids: chunk.block_ids,
          ...chunk.metadata,
        },
      })),
      importance: 0.9,
      project_shared: projectShared,
    });

    return {
      memory_id: write.id,
      source_key: sourceKey,
      document_id: documentId,
      revision_id: revisionId,
      title,
      chunk_count: normalized.chunks.length,
      content_hash: normalized.content_hash,
      replaced: write.replaced,
    };
  }

  start(): void {
    if (!this.isEnabled() || this.pollTimer) {
      return;
    }
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (!this.pollTimer) {
      return;
    }
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async triggerSync(
    scope: { orgId: string; projectId: string },
    connectorId: string,
    options: { trigger: 'manual' | 'poll'; wait: boolean }
  ): Promise<FeishuSyncJob> {
    if (!this.isEnabled()) {
      throw new AgentError(
        'Feishu sync is disabled. Configure feishu.appId / feishu.appSecret first.',
        'FEISHU_SYNC_DISABLED',
        400
      );
    }
    const connector = await this.repository.requireConnector(scope, connectorId);
    const running = await this.repository.getRunningJob(connectorId);
    if (running) {
      return running;
    }

    const job = await this.repository.createSyncJob({
      connectorId: connector.id,
      orgId: connector.org_id,
      projectId: connector.project_id,
      trigger: options.trigger,
    });

    if (!options.wait) {
      setTimeout(() => {
        void this.runSyncJob(connector, job.id);
      }, 0);
      return job;
    }

    return this.runSyncJob(connector, job.id);
  }

  private async pollOnce(): Promise<void> {
    if (!this.isEnabled() || this.pollRunning) {
      return;
    }

    this.pollRunning = true;
    try {
      const connectors = await this.repository.listActiveConnectors();
      const now = Date.now();
      for (const connector of connectors) {
        const intervalSeconds = connector.config.poll_interval_seconds ?? 300;
        const intervalMs = Math.max(60000, intervalSeconds * 1000);
        const lastPolled = connector.last_polled_at ? new Date(connector.last_polled_at).getTime() : 0;
        if (lastPolled > 0 && now - lastPolled < intervalMs) {
          continue;
        }
        if (this.runningConnectorIds.has(connector.id)) {
          continue;
        }
        const running = await this.repository.getRunningJob(connector.id);
        if (running) {
          continue;
        }
        const job = await this.repository.createSyncJob({
          connectorId: connector.id,
          orgId: connector.org_id,
          projectId: connector.project_id,
          trigger: 'poll',
        });
        void this.runSyncJob(connector, job.id);
      }
    } catch (error) {
      logger.warn('Feishu poll tick failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.pollRunning = false;
    }
  }

  private async runSyncJob(connector: FeishuConnector, jobId: string): Promise<FeishuSyncJob> {
    const stats = emptyStats();
    if (this.runningConnectorIds.has(connector.id)) {
      const running = await this.repository.getRunningJob(connector.id);
      if (running) {
        return running;
      }
    }

    this.runningConnectorIds.add(connector.id);
    await this.repository.touchConnectorPolledAt(connector.id);
    await this.repository.setSyncJobRunning(jobId);

    try {
      const sources = await this.discoverSources(connector);
      stats.discovered = sources.length;
      const limitedSources = sources.slice(0, connector.config.max_docs_per_sync);
      if (sources.length > limitedSources.length) {
        stats.skipped += sources.length - limitedSources.length;
      }

      for (const source of limitedSources) {
        try {
          if (source.kind === 'docx') {
            const result = await this.syncDocxSource(connector, source);
            if (result.status === 'processed') {
              stats.processed += 1;
              stats.docx_docs += 1;
              stats.chunk_count += result.chunkCount;
            } else {
              stats.skipped += 1;
            }
            continue;
          }

          const result = await this.syncBitableSource(connector, source);
          stats.processed += result.processed;
          stats.skipped += result.skipped;
          stats.bitable_tables += result.processed;
          stats.chunk_count += result.chunkCount;
        } catch (error) {
          stats.failed += 1;
          logger.warn('Feishu source sync failed', {
            connectorId: connector.id,
            sourceType: source.kind,
            sourceId: source.kind === 'docx' ? source.document_id : source.app_token,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const completed = await this.repository.setSyncJobCompleted(jobId, stats);
      await this.repository.updateConnectorSyncResult({
        connectorId: connector.id,
        success: true,
        errorMessage: null,
      });
      return completed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = await this.repository.setSyncJobFailed(jobId, stats, message);
      await this.repository.updateConnectorSyncResult({
        connectorId: connector.id,
        success: false,
        errorMessage: message,
      });
      return failed;
    } finally {
      this.runningConnectorIds.delete(connector.id);
    }
  }

  private async discoverSources(connector: FeishuConnector): Promise<SyncSource[]> {
    const client = this.requireClient();
    const sources: SyncSource[] = [];
    const seen = new Set<string>();

    const push = (source: SyncSource): void => {
      const key =
        source.kind === 'docx'
          ? `docx:${source.document_id}`
          : `bitable:${source.app_token}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      sources.push(source);
    };

    for (const token of connector.config.file_tokens) {
      // 优先尝试 Drive 探测类型，若权限不足/接口不可用则�?docx token 兜底�?
      try {
        const file = await client.getDriveFile(token);
        if (file) {
          if (isDocxType(file.type)) {
            push({
              kind: 'docx',
              file_token: file.token,
              document_id: file.token,
              title: file.name,
              revision_id: file.revision_id,
            });
            continue;
          }
          if (isBitableType(file.type)) {
            push({
              kind: 'bitable',
              file_token: file.token,
              app_token: file.token,
              title: file.name,
              revision_id: file.revision_id,
            });
            continue;
          }
          push({
            kind: 'docx',
            file_token: file.token,
            document_id: file.token,
            title: file.name,
            revision_id: file.revision_id,
          });
          continue;
        }
      } catch (error) {
        logger.info('Drive file inspect skipped, fallback to docx token', {
          connectorId: connector.id,
          fileToken: token,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      push({
        kind: 'docx',
        file_token: token,
        document_id: token,
        title: token,
        revision_id: null,
      });
    }

    for (const wikiToken of connector.config.wiki_node_tokens) {
      // 当前先按 docx token 直读，避免强依赖 wiki:node scope�?
      push({
        kind: 'docx',
        file_token: wikiToken,
        document_id: wikiToken,
        title: wikiToken,
        revision_id: null,
      });
    }

    for (const folderToken of connector.config.folder_tokens) {
      try {
        const files = await client.listFolderFiles(folderToken);
        for (const file of files) {
          if (isDocxType(file.type)) {
            push({
              kind: 'docx',
              file_token: file.token,
              document_id: file.token,
              title: file.name,
              revision_id: file.revision_id,
            });
          } else if (isBitableType(file.type)) {
            push({
              kind: 'bitable',
              file_token: file.token,
              app_token: file.token,
              title: file.name,
              revision_id: file.revision_id,
            });
          }
        }
      } catch (error) {
        logger.warn('Failed to list files by folder token', {
          connectorId: connector.id,
          folderToken,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const token of connector.config.bitable_app_tokens) {
      push({
        kind: 'bitable',
        file_token: null,
        app_token: token,
        title: token,
        revision_id: null,
      });
    }

    return sources;
  }

  private async syncDocxSource(
    connector: FeishuConnector,
    source: SyncSourceDocx
  ): Promise<{ status: 'processed' | 'skipped'; chunkCount: number }> {
    const client = this.requireClient();
    const blocks = await client.listDocxBlocks(source.document_id);
    const rawContent = await client.getDocxRawContent(source.document_id).catch(() => null);
    const normalized = normalizeDocxToChunks({
      title: source.title,
      blocks: blocks.items,
      rawContent,
      chunking: connector.config.chunking,
    });
    const sourceKey = `docx:${source.document_id}`;
    const revisionId = blocks.document_revision_id ?? source.revision_id;

    const state = await this.repository.getSourceState(connector.id, sourceKey);
    if (
      state &&
      state.revision_id === revisionId &&
      state.content_hash === normalized.content_hash
    ) {
      return { status: 'skipped', chunkCount: 0 };
    }

    const scope: MemoryScope = {
      org_id: connector.org_id,
      user_id: connector.created_by,
      project_id: connector.project_id,
    };

    const write = await this.memoryService.replace_archival_document({
      scope,
      source: {
        source_type: 'feishu_docx',
        source_key: sourceKey,
      },
      text: normalized.text,
      metadata: {
        connector_id: connector.id,
        file_token: source.file_token,
        document_id: source.document_id,
        title: source.title,
        revision_id: revisionId,
      },
      chunks: normalized.chunks.map((chunk) => ({
        text: chunk.text,
        snippet: chunk.snippet,
        metadata: {
          source_type: 'feishu_docx',
          chunk_type: chunk.chunk_type,
          title_path: chunk.title_path,
          block_ids: chunk.block_ids,
          ...chunk.metadata,
        },
      })),
      importance: 0.9,
      project_shared: true,
    });

    await this.repository.upsertSourceState({
      connectorId: connector.id,
      sourceKey,
      sourceType: 'docx',
      sourceId: source.document_id,
      revisionId,
      contentHash: normalized.content_hash,
      metadata: {
        memory_id: write.id,
        title: source.title,
      },
      updatedAt: new Date().toISOString(),
    });
    return { status: 'processed', chunkCount: normalized.chunks.length };
  }

  private async syncBitableSource(
    connector: FeishuConnector,
    source: SyncSourceBitable
  ): Promise<{ processed: number; skipped: number; chunkCount: number }> {
    const client = this.requireClient();
    const app = await client.getBitableApp(source.app_token);
    if (!app) {
      return { processed: 0, skipped: 1, chunkCount: 0 };
    }

    const tables = await client.listBitableTables(source.app_token);
    if (tables.length === 0) {
      return { processed: 0, skipped: 1, chunkCount: 0 };
    }

    let processed = 0;
    let skipped = 0;
    let chunkCount = 0;

    for (const table of tables) {
      const fields = await client.listBitableFields(source.app_token, table.table_id);
      const records = await client.searchBitableRecords(
        source.app_token,
        table.table_id,
        connector.config.max_records_per_table
      );

      const normalized = normalizeBitableTableToChunks({
        appToken: source.app_token,
        appName: app.name,
        tableId: table.table_id,
        tableName: table.name,
        fields,
        records,
        chunking: connector.config.chunking,
      });
      const sourceKey = `bitable:${source.app_token}:${table.table_id}`;
      const revisionId = `${app.revision ?? 'na'}:${table.revision ?? 'na'}:${records.length}`;

      const state = await this.repository.getSourceState(connector.id, sourceKey);
      if (
        state &&
        state.revision_id === revisionId &&
        state.content_hash === normalized.content_hash
      ) {
        skipped += 1;
        continue;
      }

      const scope: MemoryScope = {
        org_id: connector.org_id,
        user_id: connector.created_by,
        project_id: connector.project_id,
      };

      const write = await this.memoryService.replace_archival_document({
        scope,
        source: {
          source_type: 'feishu_bitable',
          source_key: sourceKey,
        },
        text: normalized.text,
        metadata: {
          connector_id: connector.id,
          app_token: source.app_token,
          app_name: app.name,
          table_id: table.table_id,
          table_name: table.name,
          revision_id: revisionId,
        },
        chunks: normalized.chunks.map((chunk) => ({
          text: chunk.text,
          snippet: chunk.snippet,
          metadata: {
            source_type: 'feishu_bitable',
            chunk_type: chunk.chunk_type,
            title_path: chunk.title_path,
            ...chunk.metadata,
          },
        })),
        importance: 0.85,
        project_shared: true,
      });

      await this.repository.upsertSourceState({
        connectorId: connector.id,
        sourceKey,
        sourceType: 'bitable',
        sourceId: `${source.app_token}:${table.table_id}`,
        revisionId,
        contentHash: normalized.content_hash,
        metadata: {
          memory_id: write.id,
          app_name: app.name,
          table_name: table.name,
        },
        updatedAt: new Date().toISOString(),
      });

      processed += 1;
      chunkCount += normalized.chunks.length;
    }

    return { processed, skipped, chunkCount };
  }

  private requireClient(): FeishuClient {
    if (!this.client) {
      throw new Error('Feishu client is not initialized');
    }
    return this.client;
  }
}







