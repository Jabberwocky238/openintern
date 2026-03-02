/**
 * Uploads API - File upload and download endpoints
 *
 * Endpoints:
 * - POST /api/uploads - Upload a file (multipart/form-data or raw body)
 * - GET /api/uploads/:upload_id - Download a file
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { logger } from '@openintern/utils';
import { resolveRequestScope } from '../runtime/request-scope.js';
import { UploadService } from '../runtime/upload-service.js';
import { MAX_FILE_SIZE } from '../../types/upload.js';

export interface UploadsRouterConfig {
  uploadService: UploadService;
}

/**
 * Parse raw body from request into a Buffer.
 * Expects Content-Type header for mime type and X-Filename header for original name.
 */
async function readRawBody(req: Request, maxSize: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        reject(new ValidationError(`File too large (max ${maxSize} bytes)`, 'file'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    req.on('error', (err) => {
      reject(err);
    });
  });
}

export function createUploadsRouter(config: UploadsRouterConfig): Router {
  const router = Router();
  const { uploadService } = config;

  /**
   * POST /uploads - Upload a file
   *
   * Accepts raw binary body with headers:
   * - Content-Type: the file's MIME type
   * - X-Filename: original filename
   */
  router.post('/uploads', (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        const scope = resolveRequestScope(req);
        const mimeType = req.headers['content-type'] ?? 'application/octet-stream';
        const filename = (req.headers['x-filename'] as string | undefined) ?? 'upload';

        if (!filename || typeof filename !== 'string') {
          throw new ValidationError('X-Filename header is required', 'filename');
        }

        const buffer = await readRawBody(req, MAX_FILE_SIZE);

        if (buffer.length === 0) {
          throw new ValidationError('Empty file', 'file');
        }

        const record = await uploadService.store(buffer, filename, mimeType, scope);

        res.status(201).json({
          upload_id: record.id,
          original_name: record.originalName,
          mime_type: record.mimeType,
          size: record.size,
        });
      } catch (error) {
        next(error);
      }
    })();
  });

  /**
   * GET /uploads/:upload_id - Download a file
   */
  router.get('/uploads/:upload_id', (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        const { upload_id: uploadId } = req.params;
        if (!uploadId) {
          throw new ValidationError('upload_id is required', 'upload_id');
        }

        const scope = resolveRequestScope(req);
        const { buffer, record } = await uploadService.readFile(uploadId, scope);

        res.setHeader('Content-Type', record.mimeType);
        res.setHeader('Content-Disposition', `inline; filename="${record.originalName}"`);
        res.setHeader('Content-Length', buffer.length.toString());
        res.send(buffer);
      } catch (error) {
        next(error);
      }
    })();
  });

  // Error handling middleware for upload-specific errors
  router.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof NotFoundError) {
      res.status(err.statusCode).json({
        error: { code: err.code, message: err.message, details: err.details },
      });
      return;
    }
    if (err instanceof ValidationError) {
      res.status(err.statusCode).json({
        error: { code: err.code, message: err.message, details: err.details },
      });
      return;
    }
    next(err);
  });

  logger.info('Uploads router initialized');
  return router;
}

