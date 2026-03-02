import type { IPostgresPool } from '@openintern/repository';
import type { MemoryService } from '../memory-service.js';

/** Shared dependencies available to all plugins. */
export interface PluginContext {
  pool: IPostgresPool;
  memoryService: MemoryService;
}

/** Lifecycle interface every plugin must implement. */
export interface Plugin {
  provider: string;
  init(ctx: PluginContext): Promise<void>;
  start(): void;
  stop(): void;
}

