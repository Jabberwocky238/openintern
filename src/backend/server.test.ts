/**
 * Server integration tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from './server.js';
import type { ErrorResponse } from '../types/api.js';

interface HealthResponse {
  status: string;
  timestamp: string;
  queue: { length: number };
  sse: { clients: number };
}

const describeIfDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeIfDatabase('Server', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'server-test-')
    );
  });

  afterEach(async () => {
    await fs.promises.rm(testDir, { recursive: true, force: true });
  });

  describe('createApp', () => {
    it('should create app with default config', () => {
      const { app, runQueue, sseManager } = createApp({ baseDir: testDir });

      expect(app).toBeDefined();
      expect(runQueue).toBeDefined();
      expect(sseManager).toBeDefined();

      sseManager.shutdown();
    });
  });

  describe('Health check', () => {
    it('should return health status', async () => {
      const { app, sseManager } = createApp({ baseDir: testDir });

      const response = await request(app).get('/health');

      const body = response.body as HealthResponse;
      expect(response.status).toBe(200);
      expect(body.status).toBe('ok');
      expect(body).toHaveProperty('timestamp');
      expect(body.queue).toHaveProperty('length');
      expect(body.sse).toHaveProperty('clients');

      sseManager.shutdown();
    });
  });

  describe('404 handler', () => {
    it('should return 404 for unknown endpoints', async () => {
      const { app, sseManager } = createApp({ baseDir: testDir });

      const response = await request(app).get('/unknown/endpoint');

      const body = response.body as ErrorResponse;
      expect(response.status).toBe(404);
      expect(body.error.code).toBe('NOT_FOUND');

      sseManager.shutdown();
    });
  });

  describe('CORS', () => {
    it('should include CORS headers', async () => {
      const { app, sseManager } = createApp({ baseDir: testDir });

      const response = await request(app)
        .options('/api/runs')
        .set('Origin', 'http://localhost:3001');

      expect(response.headers['access-control-allow-origin']).toBeDefined();

      sseManager.shutdown();
    });
  });
});

