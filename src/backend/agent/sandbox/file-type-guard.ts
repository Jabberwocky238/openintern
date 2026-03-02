/**
 * FileTypeGuard - Extension whitelist/blacklist enforcement
 */

import path from 'node:path';
import { SandboxError } from '../../../utils/errors.js';
import { logger } from '../../../utils/logger.js';

export interface FileTypeGuardConfig {
  blacklist: string[];
  whitelist: string[];
}

const DEFAULT_BLACKLIST = [
  '.exe', '.sh', '.bat', '.cmd', '.ps1',
  '.dll', '.so', '.dylib', '.bin',
];

export class FileTypeGuard {
  private blacklist: Set<string>;
  private whitelist: Set<string>;

  constructor(config?: Partial<FileTypeGuardConfig>) {
    this.blacklist = new Set(
      (config?.blacklist ?? DEFAULT_BLACKLIST).map((e) => e.toLowerCase()),
    );
    this.whitelist = new Set(
      (config?.whitelist ?? []).map((e) => e.toLowerCase()),
    );
  }

  /**
   * Validate that a file extension is allowed.
   * If whitelist is non-empty, only whitelisted extensions are allowed.
   * Otherwise, blacklisted extensions are blocked.
   */
  validate(filePath: string, operation: 'read' | 'write'): void {
    const ext = path.extname(filePath).toLowerCase();
    if (!ext) return; // No extension is always allowed

    if (this.whitelist.size > 0) {
      if (!this.whitelist.has(ext)) {
        this.logViolation(filePath, ext, operation);
        throw new SandboxError(
          `File type "${ext}" is not in the whitelist`,
          'file_type_blocked',
          { path: filePath, extension: ext, operation },
        );
      }
      return;
    }

    if (this.blacklist.has(ext)) {
      this.logViolation(filePath, ext, operation);
      throw new SandboxError(
        `File type "${ext}" is blacklisted`,
        'file_type_blocked',
        { path: filePath, extension: ext, operation },
      );
    }
  }

  private logViolation(
    filePath: string,
    ext: string,
    operation: string,
  ): void {
    logger.warn('FileTypeGuard violation', {
      path: filePath,
      extension: ext,
      operation,
    });
  }
}

