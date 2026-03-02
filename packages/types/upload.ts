import { z } from 'zod';

/**
 * Supported image MIME types
 */
export const IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

/**
 * Supported text MIME types
 */
export const TEXT_MIME_TYPES = [
  'text/plain',
  'text/markdown',
  'application/json',
  'text/csv',
  'text/html',
  'text/xml',
  'application/xml',
] as const;

export const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8MB
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

/**
 * Upload record stored on disk
 */
export const UploadRecordSchema = z.object({
  id: z.string(),
  originalName: z.string(),
  mimeType: z.string(),
  size: z.number().nonnegative(),
  orgId: z.string(),
  userId: z.string(),
  projectId: z.string().nullable(),
  createdAt: z.string().datetime(),
});

export type UploadRecord = z.infer<typeof UploadRecordSchema>;

/**
 * Attachment reference sent with a run request
 */
export const AttachmentReferenceSchema = z.object({
  upload_id: z.string().min(1),
});

export type AttachmentReference = z.infer<typeof AttachmentReferenceSchema>;

/**
 * Check if a MIME type is an image
 */
export function isImageMimeType(mimeType: string): boolean {
  return (IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}

/**
 * Check if a MIME type is a text file
 */
export function isTextMimeType(mimeType: string): boolean {
  return (TEXT_MIME_TYPES as readonly string[]).includes(mimeType);
}
