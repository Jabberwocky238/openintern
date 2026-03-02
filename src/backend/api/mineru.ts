/**
 * MinerU Batch Ingest API - PDF batch import with SSE progress
 *
 * Endpoints:
 * - POST /mineru/ingest-batch - Upload multiple PDFs for batch ingest
 * - GET /mineru/ingest-batch/:jobId/progress - SSE progress stream
 * - GET /mineru/ingest-batch/:jobId - Query job status
 */

import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { Router, type NextFunction, type Request, type Response } from 'express';
import Busboy from 'busboy';
import { ValidationError } from '@openintern/utils';
import { logger } from '@openintern/utils';
import { resolveRequestScope } from '../runtime/request-scope.js';
import type { MineruIngestService } from '../runtime/integrations/mineru/ingest-service.js';
import type { MineruExtractOptions } from '@openintern/types/mineru.js';

const MAX_FILES = 20;
const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB per file

export interface MineruRouterConfig {
  mineruIngestService: MineruIngestService;
}

// --- Job types ---

type FileStatus = 'pending' | 'processing' | 'completed' | 'failed';

interface FileProgress {
  file_index: number;
  filename: string;
  status: FileStatus;
  memory_id?: string;
  chunk_count?: number;
  error?: string;
}

interface IngestJob {
  job_id: string;
  status: 'processing' | 'completed';
  files: FileProgress[];
  created_at: string;
  completed_at?: string | undefined;
  options?: MineruExtractOptions | undefined;
}

// In-memory job store
const jobs = new Map<string, IngestJob>();
// SSE listeners per job
const listeners = new Map<string, Set<Response>>();

function broadcast(jobId: string, data: Record<string, unknown>): void {
  const subs = listeners.get(jobId);
  if (!subs) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of subs) {
    res.write(payload);
  }
}

function broadcastDone(jobId: string): void {
  const subs = listeners.get(jobId);
  if (!subs) return;
  for (const res of subs) {
    res.write(`event: done\ndata: {}\n\n`);
    res.end();
  }
  listeners.delete(jobId);
}

interface ParsedUpload {
  files: Array<{ filename: string; tmpPath: string }>;
  options: MineruExtractOptions;
  projectId?: string | undefined;
}

function parseMultipart(req: Request): Promise<ParsedUpload> {
  return new Promise((resolve, reject) => {
    const bb = Busboy({
      headers: req.headers,
      limits: { files: MAX_FILES, fileSize: MAX_FILE_SIZE },
    });

    const files: Array<{ filename: string; tmpPath: string }> = [];
    const fields: Record<string, string> = {};
    const tmpDir = os.tmpdir();
    let fileCount = 0;

    bb.on('file', (fieldname, stream, info) => {
      const { filename, mimeType } = info;
      if (!filename.toLowerCase().endsWith('.pdf')) {
        stream.resume();
        reject(new ValidationError(`File "${filename}" is not a PDF`, 'file'));
        return;
      }
      fileCount++;
      if (fileCount > MAX_FILES) {
        stream.resume();
        reject(new ValidationError(`Maximum ${MAX_FILES} files allowed`, 'file'));
        return;
      }

      const tmpPath = path.join(tmpDir, `mineru-upload-${randomUUID()}.pdf`);
      const chunks: Buffer[] = [];

      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        void fs.writeFile(tmpPath, Buffer.concat(chunks)).then(() => {
          files.push({ filename, tmpPath });
        });
      });
      stream.on('error', reject);
    });

    bb.on('field', (name, value) => {
      fields[name] = value;
    });

    bb.on('close', () => {
      const options: MineruExtractOptions = {} as MineruExtractOptions;
      if (fields['model_version']) options.model_version = fields['model_version'] as MineruExtractOptions['model_version'];
      if (fields['is_ocr'] === 'true') options.is_ocr = true;
      if (fields['enable_formula'] === 'true') options.enable_formula = true;
      if (fields['enable_table'] === 'true') options.enable_table = true;
      if (fields['language']) options.language = fields['language'];

      resolve({ files, options, projectId: fields['project_id'] || undefined });
    });

    bb.on('error', reject);
    req.pipe(bb);
  });
}

export function createMineruRouter(config: MineruRouterConfig): Router {
  const router = Router();
  const { mineruIngestService } = config;

  /**
   * POST /mineru/ingest-batch - Upload PDFs for batch ingest
   */
  router.post('/mineru/ingest-batch', (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        const scope = resolveRequestScope(req);

        if (!mineruIngestService.isEnabled()) {
          throw new ValidationError('MinerU is not enabled', 'mineru');
        }

        const parsed = await parseMultipart(req);
        if (parsed.files.length === 0) {
          throw new ValidationError('At least one PDF file is required', 'file');
        }

        const jobId = randomUUID();
        const job: IngestJob = {
          job_id: jobId,
          status: 'processing',
          files: parsed.files.map((f, i) => ({
            file_index: i,
            filename: f.filename,
            status: 'pending' as FileStatus,
          })),
          created_at: new Date().toISOString(),
          options: Object.keys(parsed.options).length > 0 ? parsed.options : undefined,
        };
        jobs.set(jobId, job);

        res.status(202).json({ job_id: jobId, file_count: parsed.files.length });

        // Process files in background
        void processJob(mineruIngestService, job, parsed, scope);
      } catch (error) {
        next(error);
      }
    })();
  });

  /**
   * GET /mineru/ingest-batch/:jobId/progress - SSE progress stream
   */
  router.get('/mineru/ingest-batch/:jobId/progress', (req: Request, res: Response) => {
    const { jobId } = req.params;
    const job = jobs.get(jobId!);
    if (!job) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Job not found' } });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Send current state snapshot
    for (const file of job.files) {
      res.write(`data: ${JSON.stringify(file)}\n\n`);
    }

    if (job.status === 'completed') {
      res.write(`event: done\ndata: {}\n\n`);
      res.end();
      return;
    }

    // Register listener for future updates
    if (!listeners.has(jobId!)) {
      listeners.set(jobId!, new Set());
    }
    listeners.get(jobId!)!.add(res);

    req.on('close', () => {
      listeners.get(jobId!)?.delete(res);
    });
  });

  /**
   * GET /mineru/ingest-batch/:jobId - Query job status
   */
  router.get('/mineru/ingest-batch/:jobId', (req: Request, res: Response) => {
    const { jobId } = req.params;
    const job = jobs.get(jobId!);
    if (!job) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Job not found' } });
      return;
    }
    res.json(job);
  });

  return router;
}

// --- Background processing ---

interface ScopeArg {
  orgId: string;
  userId: string;
  projectId: string | null;
}

async function processJob(
  service: MineruIngestService,
  job: IngestJob,
  parsed: ParsedUpload,
  scope: ScopeArg,
): Promise<void> {
  for (let i = 0; i < parsed.files.length; i++) {
    const file = parsed.files[i]!;
    const progress = job.files[i]!;

    progress.status = 'processing';
    broadcast(job.job_id, { ...progress });

    try {
      const result = await service.ingestPdf({
        scope: {
          orgId: scope.orgId,
          userId: scope.userId,
          projectId: parsed.projectId ?? scope.projectId,
        },
        file_path: file.tmpPath,
        title: file.filename.replace(/\.pdf$/i, ''),
        ...(job.options ? { options: job.options } : {}),
      });

      progress.status = 'completed';
      progress.memory_id = result.memory_id;
      progress.chunk_count = result.chunk_count;
    } catch (err) {
      progress.status = 'failed';
      progress.error = err instanceof Error ? err.message : String(err);
      logger.warn('MinerU batch ingest file failed', {
        job_id: job.job_id,
        file_index: i,
        filename: file.filename,
        error: progress.error,
      });
    }

    broadcast(job.job_id, { ...progress });

    // Clean up temp file
    void fs.rm(file.tmpPath, { force: true }).catch(() => {});
  }

  job.status = 'completed';
  job.completed_at = new Date().toISOString();
  broadcastDone(job.job_id);
}

