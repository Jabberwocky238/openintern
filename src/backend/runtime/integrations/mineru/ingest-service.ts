import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import type { MemoryScope } from '@openintern/types/memory.js';
import { AgentError } from '@openintern/utils';
import { logger } from '@openintern/utils';
import { MemoryService } from '../../memory-service.js';
import { MineruClient } from './client.js';
import { normalizeMineruOutputToChunks } from './normalizer.js';
import type { MineruExtractOptions, MineruModelVersion } from '@openintern/types/mineru.js';

const execFileAsync = promisify(execFile);

export interface MineruIngestServiceConfig {
  enabled: boolean;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  defaultModelVersion?: MineruModelVersion;
}

export interface MineruIngestPdfInput {
  scope: {
    orgId: string;
    userId: string;
    projectId: string | null;
  };
  file_url?: string;
  file_path?: string;
  source_key?: string;
  title?: string;
  project_shared?: boolean;
  metadata?: Record<string, unknown>;
  options?: MineruExtractOptions;
}

export interface MineruIngestPdfResult {
  memory_id: string;
  source_key: string;
  task_id: string;
  data_id: string | null;
  mode: 'v4';
  title: string;
  chunk_count: number;
  content_hash: string;
  replaced: number;
}

interface ExtractedMineruOutput {
  markdown: string | null;
  contentList: unknown;
  outputName: string | null;
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function hashKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function inferTitleFromUrl(fileUrl: string): string {
  try {
    const parsed = new URL(fileUrl);
    const seg = parsed.pathname.split('/').filter(Boolean).pop();
    if (seg) {
      return decodeURIComponent(seg);
    }
  } catch {
    // noop
  }
  return 'mineru_pdf';
}

function inferTitleFromPath(filePath: string): string {
  const base = path.basename(filePath);
  const normalized = base.replace(/\.[^.]+$/u, '').trim();
  return normalized || 'mineru_pdf';
}

function normalizeUnzipEntries(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export class MineruIngestService {
  private readonly enabled: boolean;
  private readonly pollIntervalMs: number;
  private readonly maxPollAttempts: number;
  private readonly defaultModelVersion: MineruModelVersion;

  constructor(
    private readonly memoryService: MemoryService,
    private readonly client: MineruClient | null,
    config: MineruIngestServiceConfig
  ) {
    this.enabled = config.enabled;
    this.pollIntervalMs = Math.max(1000, config.pollIntervalMs ?? 3000);
    this.maxPollAttempts = Math.max(1, config.maxPollAttempts ?? 120);
    this.defaultModelVersion = config.defaultModelVersion ?? 'pipeline';
  }

  isEnabled(): boolean {
    return this.enabled && this.client !== null;
  }

  async ingestPdf(input: MineruIngestPdfInput): Promise<MineruIngestPdfResult> {
    if (!this.isEnabled()) {
      throw new AgentError(
        'MinerU ingest is disabled. Configure MinerU credentials first.',
        'MINERU_DISABLED',
        400
      );
    }
    const fileUrl = readString(input.file_url);
    const filePathInput = readString(input.file_path);
    if (!fileUrl && !filePathInput) {
      throw new AgentError(
        'one of file_url or file_path is required',
        'MINERU_INPUT_REQUIRED',
        400
      );
    }
    if (fileUrl && filePathInput) {
      throw new AgentError(
        'file_url and file_path cannot both be set',
        'MINERU_INPUT_CONFLICT',
        400
      );
    }
    if (fileUrl) {
      try {
        // validate URL
        // eslint-disable-next-line no-new
        new URL(fileUrl);
      } catch {
        throw new AgentError('Invalid file_url', 'MINERU_FILE_URL_INVALID', 400);
      }
    }

    const client = this.requireClient();
    const scope: MemoryScope = {
      org_id: input.scope.orgId,
      user_id: input.scope.userId,
      ...(input.scope.projectId ? { project_id: input.scope.projectId } : {}),
    };
    const projectShared = input.project_shared ?? Boolean(input.scope.projectId);
    const options = this.buildExtractOptions(input.options);

    if (fileUrl) {
      const task = await client.createExtractTask({
        fileUrl,
        options,
      });
      const completed = await client.waitForTask(task.task_id, {
        intervalMs: this.pollIntervalMs,
        maxAttempts: this.maxPollAttempts,
      });
      if (!completed.full_zip_url) {
        throw new AgentError(
          completed.err_msg ?? 'MinerU task missing full_zip_url',
          'MINERU_RESULT_MISSING',
          502
        );
      }

      const zipBuffer = await client.downloadFile(completed.full_zip_url);
      const extracted = await this.extractZipOutput(zipBuffer);
      const title = readString(input.title) ?? extracted.outputName ?? inferTitleFromUrl(fileUrl);
      const normalized = normalizeMineruOutputToChunks({
        title,
        markdown: extracted.markdown,
        contentList: extracted.contentList,
      });
      if (!normalized.text) {
        throw new AgentError(
          'No readable content extracted from MinerU output',
          'MINERU_EMPTY_CONTENT',
          422
        );
      }
      const sourceKey =
        readString(input.source_key) ??
        `mineru:${completed.data_id ?? hashKey(fileUrl)}`;
      const write = await this.memoryService.replace_archival_document({
        scope,
        source: {
          source_type: 'pdf_mineru',
          source_key: sourceKey,
        },
        text: normalized.text,
        metadata: {
          ...(input.metadata ?? {}),
          source_url: fileUrl,
          ingest_mode: 'v4',
          task_id: completed.task_id,
          data_id: completed.data_id,
          title,
          model_version: options.model_version,
          output_name: extracted.outputName,
        },
        chunks: normalized.chunks.map((chunk) => ({
          text: chunk.text,
          snippet: chunk.snippet,
          metadata: {
            source_type: 'pdf_mineru',
            chunk_type: chunk.chunk_type,
            title_path: chunk.title_path,
            ...chunk.metadata,
          },
        })),
        importance: 0.85,
        project_shared: projectShared,
      });

      return {
        memory_id: write.id,
        source_key: sourceKey,
        task_id: completed.task_id,
        data_id: completed.data_id,
        mode: 'v4',
        title,
        chunk_count: normalized.chunks.length,
        content_hash: normalized.content_hash,
        replaced: write.replaced,
      };
    }

    const localPdfPath = await this.validateLocalPdfPath(filePathInput as string);
    const fileName = path.basename(localPdfPath);
    const batchDataId = options.data_id ?? `local_${hashKey(localPdfPath)}`;
    const batch = await client.createBatchUpload({
      files: [
        {
          name: fileName,
          data_id: batchDataId,
          ...(options.is_ocr !== undefined ? { is_ocr: options.is_ocr } : {}),
          ...(options.page_ranges ? { page_ranges: options.page_ranges } : {}),
        },
      ],
      options,
    });
    const uploadUrl = batch.file_urls[0];
    if (!uploadUrl) {
      throw new AgentError('MinerU batch upload URL missing', 'MINERU_RESULT_MISSING', 502);
    }
    await client.uploadFileToSignedUrl(uploadUrl, localPdfPath);
    const completed = await client.waitForBatchResult(batch.batch_id, {
      intervalMs: this.pollIntervalMs,
      maxAttempts: this.maxPollAttempts,
      dataId: batchDataId,
      fileName,
    });
    if (!completed.full_zip_url) {
      throw new AgentError(
        completed.err_msg ?? 'MinerU batch task missing full_zip_url',
        'MINERU_RESULT_MISSING',
        502
      );
    }
    const zipBuffer = await client.downloadFile(completed.full_zip_url);
    const extracted = await this.extractZipOutput(zipBuffer);
    const title = readString(input.title) ?? extracted.outputName ?? inferTitleFromPath(localPdfPath);
    const normalized = normalizeMineruOutputToChunks({
      title,
      markdown: extracted.markdown,
      contentList: extracted.contentList,
    });
    if (!normalized.text) {
      throw new AgentError(
        'No readable content extracted from MinerU output',
        'MINERU_EMPTY_CONTENT',
        422
      );
    }
    const sourceKey =
      readString(input.source_key) ??
      `mineru:${completed.data_id ?? hashKey(localPdfPath)}`;
    const taskId = `batch:${batch.batch_id}:${completed.data_id ?? hashKey(localPdfPath)}`;
    const write = await this.memoryService.replace_archival_document({
      scope,
      source: {
        source_type: 'pdf_mineru',
        source_key: sourceKey,
      },
      text: normalized.text,
      metadata: {
        ...(input.metadata ?? {}),
        source_file_path: localPdfPath,
        ingest_mode: 'v4',
        task_id: taskId,
        batch_id: batch.batch_id,
        data_id: completed.data_id,
        title,
        model_version: options.model_version,
        output_name: extracted.outputName,
      },
      chunks: normalized.chunks.map((chunk) => ({
        text: chunk.text,
        snippet: chunk.snippet,
        metadata: {
          source_type: 'pdf_mineru',
          chunk_type: chunk.chunk_type,
          title_path: chunk.title_path,
          ...chunk.metadata,
        },
      })),
      importance: 0.85,
      project_shared: projectShared,
    });

    return {
      memory_id: write.id,
      source_key: sourceKey,
      task_id: taskId,
      data_id: completed.data_id,
      mode: 'v4',
      title,
      chunk_count: normalized.chunks.length,
      content_hash: normalized.content_hash,
      replaced: write.replaced,
    };
  }

  private buildExtractOptions(options: MineruExtractOptions | undefined): MineruExtractOptions {
    return {
      model_version: options?.model_version ?? this.defaultModelVersion,
      ...(options?.is_ocr !== undefined ? { is_ocr: options.is_ocr } : {}),
      ...(options?.enable_formula !== undefined
        ? { enable_formula: options.enable_formula }
        : {}),
      ...(options?.enable_table !== undefined
        ? { enable_table: options.enable_table }
        : {}),
      ...(options?.language ? { language: options.language } : {}),
      ...(options?.page_ranges ? { page_ranges: options.page_ranges } : {}),
      ...(options?.no_cache !== undefined ? { no_cache: options.no_cache } : {}),
      ...(options?.cache_tolerance !== undefined
        ? { cache_tolerance: options.cache_tolerance }
        : {}),
      ...(options?.data_id ? { data_id: options.data_id } : {}),
    };
  }

  private async validateLocalPdfPath(rawPath: string): Promise<string> {
    const resolved = path.resolve(rawPath);
    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch {
      throw new AgentError('file_path does not exist', 'MINERU_FILE_PATH_NOT_FOUND', 400);
    }
    if (!stat.isFile()) {
      throw new AgentError('file_path must be a file', 'MINERU_FILE_PATH_INVALID', 400);
    }
    if (path.extname(resolved).toLowerCase() !== '.pdf') {
      throw new AgentError('file_path must point to a PDF file', 'MINERU_FILE_PATH_INVALID', 400);
    }
    return resolved;
  }

  private requireClient(): MineruClient {
    if (!this.client) {
      throw new Error('MinerU client is not initialized');
    }
    return this.client;
  }

  private async extractZipOutput(zipBuffer: Buffer): Promise<ExtractedMineruOutput> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mineru-out-'));
    const zipPath = path.join(tempDir, 'mineru_output.zip');
    try {
      await fs.writeFile(zipPath, zipBuffer);
      const { stdout: listStdout } = await execFileAsync('unzip', ['-Z1', zipPath], {
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024 * 8,
      });
      const entries = normalizeUnzipEntries(listStdout);
      if (entries.length === 0) {
        throw new AgentError('MinerU output zip is empty', 'MINERU_ZIP_EMPTY', 502);
      }

      const contentListEntry =
        entries.find((entry) => entry.endsWith('_content_list.json')) ??
        entries.find((entry) => entry.endsWith('.json') && entry.includes('content_list')) ??
        null;
      const markdownEntry =
        entries.find((entry) => entry.toLowerCase().endsWith('.md')) ??
        null;
      const outputName = this.inferOutputName(entries);

      const markdown = markdownEntry
        ? await this.readZipEntryText(zipPath, markdownEntry)
        : null;
      const contentListText = contentListEntry
        ? await this.readZipEntryText(zipPath, contentListEntry)
        : null;
      const contentList = this.parseContentList(contentListText);

      return { markdown, contentList, outputName };
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes('ENOENT') || error.message.includes('not found'))
      ) {
        throw new AgentError(
          'unzip command is required to parse MinerU result archive',
          'MINERU_UNZIP_MISSING',
          500
        );
      }
      logger.warn('Failed to extract MinerU zip output', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  private async readZipEntryText(zipPath: string, entry: string): Promise<string> {
    const { stdout } = await execFileAsync('unzip', ['-p', zipPath, entry], {
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024 * 20,
    });
    return readString(stdout) ?? '';
  }

  private parseContentList(content: string | null): unknown {
    if (!content) {
      return [];
    }
    try {
      const parsed = JSON.parse(content) as unknown;
      return parsed;
    } catch (error) {
      logger.warn('Failed to parse MinerU content_list json', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private inferOutputName(entries: string[]): string | null {
    const candidate =
      entries.find((entry) => entry.endsWith('_content_list.json')) ??
      entries.find((entry) => entry.toLowerCase().endsWith('.md')) ??
      entries[0] ??
      null;
    if (!candidate) {
      return null;
    }
    const base = path.basename(candidate);
    return base
      .replace(/_content_list\.json$/i, '')
      .replace(/\.md$/i, '');
  }
}

