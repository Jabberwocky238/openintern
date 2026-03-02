/**
 * UploadService tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { UploadService } from './upload-service.js';
import type { ScopeContext } from './scope.js';

const TEST_SCOPE: ScopeContext = {
  orgId: 'org_test',
  userId: 'user_test',
  projectId: null,
};

describe('UploadService', () => {
  let testDir: string;
  let service: UploadService;

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'upload-test-'));
    service = new UploadService(testDir);
  });

  afterEach(async () => {
    await fs.promises.rm(testDir, { recursive: true, force: true });
  });

  describe('store', () => {
    it('should store a file and return a record', async () => {
      const buffer = Buffer.from('hello world');
      const record = await service.store(buffer, 'test.txt', 'text/plain', TEST_SCOPE);

      expect(record.id).toMatch(/^upl_/);
      expect(record.originalName).toBe('test.txt');
      expect(record.mimeType).toBe('text/plain');
      expect(record.size).toBe(11);
      expect(record.orgId).toBe('org_test');
      expect(record.userId).toBe('user_test');
      expect(record.createdAt).toBeTruthy();
    });

    it('should sanitize filenames with special characters', async () => {
      const buffer = Buffer.from('data');
      const record = await service.store(buffer, '../../../etc/passwd', 'text/plain', TEST_SCOPE);

      expect(record.originalName).not.toContain('..');
      expect(record.originalName).not.toContain('/');
    });

    it('should reject files exceeding max size', async () => {
      const buffer = Buffer.alloc(9 * 1024 * 1024); // 9MB
      await expect(
        service.store(buffer, 'big.bin', 'application/octet-stream', TEST_SCOPE),
      ).rejects.toThrow(/too large/i);
    });
  });

  describe('getRecord', () => {
    it('should retrieve a stored record', async () => {
      const buffer = Buffer.from('test content');
      const stored = await service.store(buffer, 'doc.txt', 'text/plain', TEST_SCOPE);

      const retrieved = await service.getRecord(stored.id, TEST_SCOPE);
      expect(retrieved.id).toBe(stored.id);
      expect(retrieved.originalName).toBe('doc.txt');
    });

    it('should throw for non-existent upload', async () => {
      await expect(
        service.getRecord('upl_nonexistent', TEST_SCOPE),
      ).rejects.toThrow(/not found/i);
    });

    it('should deny access for wrong scope', async () => {
      const buffer = Buffer.from('secret');
      const stored = await service.store(buffer, 'secret.txt', 'text/plain', TEST_SCOPE);

      const otherScope: ScopeContext = {
        orgId: 'org_other',
        userId: 'user_other',
        projectId: null,
      };

      await expect(
        service.getRecord(stored.id, otherScope),
      ).rejects.toThrow();
    });
  });

  describe('readFile', () => {
    it('should read back the stored file content', async () => {
      const content = 'file content here';
      const buffer = Buffer.from(content);
      const stored = await service.store(buffer, 'readme.md', 'text/markdown', TEST_SCOPE);

      const { buffer: readBuffer, record } = await service.readFile(stored.id, TEST_SCOPE);
      expect(readBuffer.toString('utf-8')).toBe(content);
      expect(record.mimeType).toBe('text/markdown');
    });
  });

  describe('resolveAttachments', () => {
    it('should resolve text files as text content parts', async () => {
      const buffer = Buffer.from('some text');
      const stored = await service.store(buffer, 'notes.txt', 'text/plain', TEST_SCOPE);

      const parts = await service.resolveAttachments([stored.id], TEST_SCOPE);
      expect(parts).toHaveLength(1);
      expect(parts[0]!.type).toBe('text');
      if (parts[0]!.type === 'text') {
        expect(parts[0]!.text).toContain('some text');
        expect(parts[0]!.text).toContain('[File: notes.txt]');
      }
    });

    it('should resolve images as base64 image content parts', async () => {
      // Create a tiny PNG-like buffer
      const buffer = Buffer.from('fake-png-data');
      const stored = await service.store(buffer, 'photo.png', 'image/png', TEST_SCOPE);

      const parts = await service.resolveAttachments([stored.id], TEST_SCOPE);
      expect(parts).toHaveLength(1);
      expect(parts[0]!.type).toBe('image');
      if (parts[0]!.type === 'image') {
        expect(parts[0]!.image.mimeType).toBe('image/png');
        expect(parts[0]!.image.data).toBe(buffer.toString('base64'));
      }
    });

    it('should resolve multiple attachments', async () => {
      const txt = await service.store(Buffer.from('text'), 'a.txt', 'text/plain', TEST_SCOPE);
      const img = await service.store(Buffer.from('img'), 'b.png', 'image/png', TEST_SCOPE);

      const parts = await service.resolveAttachments([txt.id, img.id], TEST_SCOPE);
      expect(parts).toHaveLength(2);
      expect(parts[0]!.type).toBe('text');
      expect(parts[1]!.type).toBe('image');
    });

    it('should handle unsupported file types gracefully', async () => {
      const buffer = Buffer.from('binary data');
      const stored = await service.store(buffer, 'data.bin', 'application/octet-stream', TEST_SCOPE);

      const parts = await service.resolveAttachments([stored.id], TEST_SCOPE);
      expect(parts).toHaveLength(1);
      expect(parts[0]!.type).toBe('text');
      if (parts[0]!.type === 'text') {
        expect(parts[0]!.text).toContain('Attached file');
      }
    });
  });
});

