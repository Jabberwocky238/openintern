/**
 * UploadService - Local file storage for chat attachments
 *
 * Stores files in uploads/<org_id>/<user_id>/<upload_id>/ with metadata.
 * Provides scope-based access control.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '@openintern/utils';
import { generateUploadId } from '../../utils/ids.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import {
  type UploadRecord,
  MAX_FILE_SIZE,
  isImageMimeType,
  isTextMimeType,
} from '../../types/upload.js';
import type { ContentPart } from '../../types/agent.js';
import type { ScopeContext } from './scope.js';

export class UploadService {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir, 'uploads');
  }

  /**
   * Store an uploaded file. Returns the upload record.
   */
  async store(
    buffer: Buffer,
    originalName: string,
    mimeType: string,
    scope: ScopeContext,
  ): Promise<UploadRecord> {
    if (buffer.length > MAX_FILE_SIZE) {
      throw new ValidationError(`File too large: ${buffer.length} bytes (max ${MAX_FILE_SIZE})`, 'file');
    }

    // Sanitize filename to prevent path traversal
    const safeName = path.basename(originalName).replace(/[^a-zA-Z0-9._-]/g, '_');
    const id = generateUploadId();
    const dir = this.uploadDir(scope, id);

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, safeName), buffer);

    const record: UploadRecord = {
      id,
      originalName: safeName,
      mimeType,
      size: buffer.length,
      orgId: scope.orgId,
      userId: scope.userId,
      projectId: scope.projectId,
      createdAt: new Date().toISOString(),
    };

    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(record));
    logger.info('File uploaded', { id, name: safeName, size: buffer.length, mimeType });
    return record;
  }

  /**
   * Retrieve an upload record and verify scope access.
   */
  async getRecord(uploadId: string, scope: ScopeContext): Promise<UploadRecord> {
    const dir = this.uploadDir(scope, uploadId);
    const metaPath = path.join(dir, 'meta.json');

    try {
      const raw = await fs.readFile(metaPath, 'utf-8');
      const record = JSON.parse(raw) as UploadRecord;

      // Verify scope
      if (record.orgId !== scope.orgId || record.userId !== scope.userId) {
        throw new NotFoundError('Upload', uploadId);
      }

      return record;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundError('Upload', uploadId);
      }
      throw err;
    }
  }

  /**
   * Read the raw file buffer for an upload.
   */
  async readFile(uploadId: string, scope: ScopeContext): Promise<{ buffer: Buffer; record: UploadRecord }> {
    const record = await this.getRecord(uploadId, scope);
    const filePath = path.join(this.uploadDir(scope, uploadId), record.originalName);
    const buffer = await fs.readFile(filePath);
    return { buffer, record };
  }

  /**
   * Resolve attachment references into ContentPart arrays for LLM consumption.
   * Images become base64 image parts, text files become text parts.
   */
  async resolveAttachments(
    uploadIds: string[],
    scope: ScopeContext,
  ): Promise<ContentPart[]> {
    const parts: ContentPart[] = [];

    for (const uploadId of uploadIds) {
      const { buffer, record } = await this.readFile(uploadId, scope);

      if (isImageMimeType(record.mimeType)) {
        parts.push({
          type: 'image',
          image: {
            data: buffer.toString('base64'),
            mimeType: record.mimeType,
          },
        });
      } else if (isTextMimeType(record.mimeType)) {
        const text = buffer.toString('utf-8');
        parts.push({
          type: 'text',
          text: `[File: ${record.originalName}]\n${text}`,
        });
      } else {
        // Unsupported file type - include as text reference
        parts.push({
          type: 'text',
          text: `[Attached file: ${record.originalName} (${record.mimeType}, ${record.size} bytes)]`,
        });
      }
    }

    return parts;
  }

  private uploadDir(scope: ScopeContext, uploadId: string): string {
    return path.join(this.baseDir, scope.orgId, scope.userId, uploadId);
  }
}

