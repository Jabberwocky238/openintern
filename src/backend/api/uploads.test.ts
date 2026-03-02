/**
 * Uploads API tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request, { type Test } from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { createUploadsRouter } from './uploads.js';
import { UploadService } from '../runtime/upload-service.js';
import { ValidationError } from '@openintern/utils';

const TEST_SCOPE = {
  orgId: 'org_test',
  userId: 'user_test',
} as const;

function withScope(req: Test): Test {
  return req
    .set('x-org-id', TEST_SCOPE.orgId)
    .set('x-user-id', TEST_SCOPE.userId);
}

describe('Uploads API', () => {
  let app: express.Express;
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'uploads-api-test-'));
    const uploadService = new UploadService(testDir);
    const router = createUploadsRouter({ uploadService });

    app = express();
    // Error handler for ValidationError
    app.use('/api', router);
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (err instanceof ValidationError) {
        res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: err.message } });
      } else {
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
      }
    });
  });

  afterEach(async () => {
    await fs.promises.rm(testDir, { recursive: true, force: true });
  });

  describe('POST /api/uploads', () => {
    it('should upload a file and return metadata', async () => {
      const response = await withScope(
        request(app)
          .post('/api/uploads')
          .set('Content-Type', 'text/plain')
          .set('X-Filename', 'hello.txt')
          .send('Hello, world!')
      );

      expect(response.status).toBe(201);
      const body = response.body as { upload_id: string; original_name: string; mime_type: string; size: number };
      expect(body).toHaveProperty('upload_id');
      expect(body.upload_id).toMatch(/^upl_/);
      expect(body.original_name).toBe('hello.txt');
      expect(body.mime_type).toBe('text/plain');
      expect(body.size).toBeGreaterThan(0);
    });

    it('should reject requests without scope headers', async () => {
      const response = await request(app)
        .post('/api/uploads')
        .set('Content-Type', 'text/plain')
        .set('X-Filename', 'test.txt')
        .send('data');

      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/uploads/:upload_id', () => {
    it('should download a previously uploaded file', async () => {
      // Upload first
      const uploadRes = await withScope(
        request(app)
          .post('/api/uploads')
          .set('Content-Type', 'text/plain')
          .set('X-Filename', 'download-test.txt')
          .send('download me')
      );

      expect(uploadRes.status).toBe(201);
      const uploadBody = uploadRes.body as { upload_id: string };
      const uploadId = uploadBody.upload_id;

      // Download
      const downloadRes = await withScope(
        request(app).get(`/api/uploads/${uploadId}`)
      );

      expect(downloadRes.status).toBe(200);
      expect(downloadRes.headers['content-type']).toContain('text/plain');
      expect(downloadRes.text).toBe('download me');
    });

    it('should return error for non-existent upload', async () => {
      const response = await withScope(
        request(app).get('/api/uploads/upl_nonexistent')
      );

      expect(response.status).toBe(404);
    });
  });
});

