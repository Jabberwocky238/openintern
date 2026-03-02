/**
 * ToolSandbox - Facade combining all sandbox guards
 *
 * Provides a single entry point for pre-validating tool calls
 * against path jail, file type, rate limit, and permission checks.
 */

import { PathGuard } from './path-guard.js';
import { FileTypeGuard, type FileTypeGuardConfig } from './file-type-guard.js';
import { ToolRateLimiter } from './rate-limiter.js';
import { PermissionMatrix } from './permission-matrix.js';
import { SandboxError } from '../../../utils/errors.js';
import { logger } from '@openintern/utils';

export { PathGuard } from './path-guard.js';
export { FileTypeGuard } from './file-type-guard.js';
export { ToolRateLimiter } from './rate-limiter.js';
export { PermissionMatrix } from './permission-matrix.js';

export interface ToolSandboxConfig {
  enabled: boolean;
  jailDir: string;
  fileTypeBlacklist?: string[];
  fileTypeWhitelist?: string[];
  maxWriteSize?: number;
  rateLimit?: {
    maxCalls?: number;
    windowMs?: number;
  };
}

/** Tools that operate on file paths */
const FILE_TOOLS = new Set(['file_read', 'file_write', 'file_list', 'file_exists']);
const WRITE_TOOLS = new Set(['file_write']);

export class ToolSandbox {
  private enabled: boolean;
  private pathGuard: PathGuard;
  private fileTypeGuard: FileTypeGuard;
  private rateLimiter: ToolRateLimiter;
  private permissionMatrix: PermissionMatrix;
  private maxWriteSize: number;

  constructor(config: ToolSandboxConfig) {
    this.enabled = config.enabled;
    this.pathGuard = new PathGuard(config.jailDir);
    const fileTypeConfig: Partial<FileTypeGuardConfig> = {};
    if (config.fileTypeBlacklist) fileTypeConfig.blacklist = config.fileTypeBlacklist;
    if (config.fileTypeWhitelist) fileTypeConfig.whitelist = config.fileTypeWhitelist;
    this.fileTypeGuard = new FileTypeGuard(fileTypeConfig);
    this.rateLimiter = new ToolRateLimiter(config.rateLimit);
    this.permissionMatrix = new PermissionMatrix();
    this.maxWriteSize = config.maxWriteSize ?? 1048576; // 1MB default
  }

  /**
   * Pre-validate a tool call. Throws SandboxError on violation.
   */
  async validate(
    toolName: string,
    params: Record<string, unknown>,
    baseDir: string,
  ): Promise<void> {
    if (!this.enabled) return;

    // 1. Rate limit check
    this.rateLimiter.check(toolName);

    // 2. Permission check
    const operation = WRITE_TOOLS.has(toolName) ? 'write' : 'read';
    this.permissionMatrix.check(toolName, operation);

    // 3. File-specific checks
    if (FILE_TOOLS.has(toolName)) {
      const filePath = params['path'] as string | undefined;
      if (filePath && typeof filePath === 'string') {
        // Path jail + symlink check
        await this.pathGuard.validate(filePath, baseDir);

        // File type check
        this.fileTypeGuard.validate(filePath, operation);
      }
    }

    // 4. Write size check
    if (WRITE_TOOLS.has(toolName)) {
      const content = params['content'] as string | undefined;
      if (content && typeof content === 'string') {
        const size = Buffer.byteLength(content, 'utf-8');
        if (size > this.maxWriteSize) {
          throw new SandboxError(
            `Write size ${size} bytes exceeds limit of ${this.maxWriteSize} bytes`,
            'write_size_exceeded',
            { toolName, size, maxWriteSize: this.maxWriteSize },
          );
        }
      }
    }

    logger.debug('Sandbox validation passed', { toolName });
  }

  /**
   * Reset rate limiter (useful for testing).
   */
  resetRateLimiter(): void {
    this.rateLimiter.reset();
  }
}

