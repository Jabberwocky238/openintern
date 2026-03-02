/**
 * PathGuard - Symlink detection + path jail enforcement
 *
 * Ensures all file operations stay within the allowed jail directory.
 * Detects and blocks symlinks that point outside the jail.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SandboxError } from '../../../utils/errors.js';
import { logger } from '@openintern/utils';

export class PathGuard {
  private readonly jailDir: string;

  constructor(jailDir: string) {
    this.jailDir = path.resolve(jailDir);
  }

  /**
   * Validate that a path is within the jail directory.
   * Checks both the logical path and the real (resolved symlink) path.
   */
  async validate(filePath: string, baseDir: string): Promise<string> {
    const resolved = path.resolve(baseDir, filePath);
    const normalizedJail = this.jailDir + path.sep;

    // Check logical path
    if (!resolved.startsWith(normalizedJail) && resolved !== this.jailDir) {
      this.logViolation('path_traversal', filePath, resolved);
      throw new SandboxError(
        `Path "${filePath}" is outside the allowed directory`,
        'path_traversal',
        { path: filePath, resolved },
      );
    }

    // Check real path (symlink resolution)
    try {
      const realPath = await fs.promises.realpath(resolved);
      if (!realPath.startsWith(normalizedJail) && realPath !== this.jailDir) {
        this.logViolation('symlink_escape', filePath, realPath);
        throw new SandboxError(
          `Path "${filePath}" resolves to "${realPath}" outside the allowed directory`,
          'symlink_escape',
          { path: filePath, realPath },
        );
      }
      return realPath;
    } catch (err) {
      // ENOENT is OK - file doesn't exist yet (e.g., for writes)
      if (
        err instanceof Error &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        // Validate parent directory instead
        const parentDir = path.dirname(resolved);
        try {
          const realParent = await fs.promises.realpath(parentDir);
          if (
            !realParent.startsWith(normalizedJail) &&
            realParent !== this.jailDir
          ) {
            this.logViolation('symlink_escape', filePath, realParent);
            throw new SandboxError(
              `Parent directory resolves outside the allowed directory`,
              'symlink_escape',
              { path: filePath, realParent },
            );
          }
        } catch (parentErr) {
          if (parentErr instanceof SandboxError) throw parentErr;
          // Parent doesn't exist either, that's fine for mkdir -p
        }
        return resolved;
      }
      if (err instanceof SandboxError) throw err;
      throw err;
    }
  }

  private logViolation(
    type: string,
    originalPath: string,
    resolvedPath: string,
  ): void {
    logger.warn('PathGuard violation', {
      type,
      originalPath,
      resolvedPath,
      jailDir: this.jailDir,
    });
  }
}

