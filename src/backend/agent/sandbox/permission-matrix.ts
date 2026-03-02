/**
 * PermissionMatrix - Tool operation permission control
 */

import { SandboxError } from '../../../utils/errors.js';
import { logger } from '../../../utils/logger.js';

export type PermissionLevel = 'allow' | 'deny' | 'readonly';

export interface ToolPermission {
  read: boolean;
  write: boolean;
  execute: boolean;
}

const DEFAULT_PERMISSIONS: Record<string, ToolPermission> = {
  'file_read': { read: true, write: false, execute: false },
  'file_write': { read: false, write: true, execute: false },
  'file_list': { read: true, write: false, execute: false },
  'file_exists': { read: true, write: false, execute: false },
  'memory_write': { read: false, write: true, execute: false },
  'memory_search': { read: true, write: false, execute: false },
  'memory_get': { read: true, write: false, execute: false },
};

export class PermissionMatrix {
  private permissions: Map<string, ToolPermission>;

  constructor(overrides?: Record<string, Partial<ToolPermission>>) {
    this.permissions = new Map(Object.entries(DEFAULT_PERMISSIONS));

    if (overrides) {
      for (const [tool, perm] of Object.entries(overrides)) {
        const existing = this.permissions.get(tool);
        const base = existing ?? { read: true, write: false, execute: false };
        this.permissions.set(tool, { ...base, ...perm });
      }
    }
  }

  /**
   * Check if a tool has the required permission for an operation.
   */
  check(toolName: string, operation: 'read' | 'write' | 'execute'): void {
    const perm = this.permissions.get(toolName);

    // Unknown tools default to allow (extensibility)
    if (!perm) return;

    if (!perm[operation]) {
      logger.warn('Permission denied', { toolName, operation });
      throw new SandboxError(
        `Tool "${toolName}" does not have "${operation}" permission`,
        'permission_denied',
        { toolName, operation },
      );
    }
  }

  /**
   * Get permissions for a tool (or null if not configured).
   */
  getPermissions(toolName: string): ToolPermission | null {
    return this.permissions.get(toolName) ?? null;
  }
}

