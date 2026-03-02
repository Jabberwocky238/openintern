/**
 * ProjectionStore - Generate run.meta.json from events for fast UI loading
 *
 * Storage:
 * - data/sessions/<session_key>/runs/<run_id>/projections/run.meta.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { RunMetaSchema, type RunMeta } from '../../types/run.js';
import type { Event } from '../../types/events.js';
import { EventStore } from './event-store.js';
import { ProjectionStoreError } from '../../utils/errors.js';

/**
 * ProjectionStore class for generating and managing run metadata
 */
export class ProjectionStore {
  private readonly projectionsDir: string;
  private readonly runMetaPath: string;
  private readonly eventStore: EventStore;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(
    private readonly sessionKey: string,
    private readonly runId: string,
    private readonly baseDir: string = 'data'
  ) {
    const runDir = path.join(
      baseDir,
      'sessions',
      sessionKey,
      'runs',
      runId
    );
    this.projectionsDir = path.join(runDir, 'projections');
    this.runMetaPath = path.join(this.projectionsDir, 'run.meta.json');
    this.eventStore = new EventStore(sessionKey, runId, baseDir);
  }

  /**
   * Get the run meta file path
   */
  getRunMetaPath(): string {
    return this.runMetaPath;
  }

  /**
   * Get the projections directory path
   */
  getProjectionsDir(): string {
    return this.projectionsDir;
  }

  /**
   * Ensure the projections directory exists
   */
  private async ensureProjectionsDir(): Promise<void> {
    await fs.promises.mkdir(this.projectionsDir, { recursive: true });
  }

  /**
   * Generate RunMeta by scanning all events
   * @returns Generated RunMeta
   */
  async generateRunMeta(): Promise<RunMeta> {
    try {
      const events = await this.eventStore.readAll();
      const meta = this.buildMetaFromEvents(events);

      // Save the generated meta
      await this.saveRunMeta(meta);

      return meta;
    } catch (error) {
      if (error instanceof ProjectionStoreError) {
        throw error;
      }
      throw new ProjectionStoreError('Failed to generate run meta', {
        runId: this.runId,
        sessionKey: this.sessionKey,
        originalError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Build RunMeta from a list of events
   */
  private buildMetaFromEvents(events: Event[]): RunMeta {
    let status: 'pending' | 'running' | 'completed' | 'failed' = 'pending';
    let startedAt: string | null = null;
    let endedAt: string | null = null;
    let durationMs: number | null = null;
    let eventCount = 0;
    let toolCallCount = 0;

    for (const event of events) {
      eventCount++;

      switch (event.type) {
        case 'run.started':
          status = 'running';
          startedAt = event.ts;
          break;

        case 'run.completed':
          status = 'completed';
          endedAt = event.ts;
          durationMs = event.payload.duration_ms;
          break;

        case 'run.failed':
          status = 'failed';
          endedAt = event.ts;
          break;

        case 'tool.called':
          toolCallCount++;
          break;

        case 'tool.result':
          // Tool result doesn't change counts
          break;
      }
    }

    // If no start time found, use current time
    if (!startedAt) {
      startedAt = new Date().toISOString();
    }

    return {
      run_id: this.runId,
      session_key: this.sessionKey,
      status,
      started_at: startedAt,
      ended_at: endedAt,
      duration_ms: durationMs,
      event_count: eventCount,
      tool_call_count: toolCallCount,
    };
  }

  /**
   * Update RunMeta incrementally when a new event arrives
   * @param event - The new event to process
   */
  async updateRunMeta(event: Event): Promise<void> {
    // Use write lock to prevent concurrent updates (read-modify-write race condition)
    this.writeLock = this.writeLock.then(async () => {
      try {
        // Load existing meta or create new one
        let meta = await this.loadRunMeta();

        if (!meta) {
          // No existing meta, create initial state
          meta = {
            run_id: this.runId,
            session_key: this.sessionKey,
            status: 'pending',
            started_at: new Date().toISOString(),
            ended_at: null,
            duration_ms: null,
            event_count: 0,
            tool_call_count: 0,
          };
        }

        // Update meta based on event type
        meta = this.applyEventToMeta(meta, event);

        // Save updated meta
        await this.saveRunMeta(meta);
      } catch (error) {
        if (error instanceof ProjectionStoreError) {
          throw error;
        }
        throw new ProjectionStoreError('Failed to update run meta', {
          runId: this.runId,
          eventType: event.type,
          originalError: error instanceof Error ? error.message : String(error),
        });
      }
    });
    await this.writeLock;
  }

  /**
   * Apply an event to update RunMeta
   */
  private applyEventToMeta(meta: RunMeta, event: Event): RunMeta {
    // Increment event count
    const updatedMeta: RunMeta = {
      ...meta,
      event_count: meta.event_count + 1,
    };

    switch (event.type) {
      case 'run.started':
        updatedMeta.status = 'running';
        updatedMeta.started_at = event.ts;
        break;

      case 'run.completed':
        updatedMeta.status = 'completed';
        updatedMeta.ended_at = event.ts;
        updatedMeta.duration_ms = event.payload.duration_ms;
        break;

      case 'run.failed':
        updatedMeta.status = 'failed';
        updatedMeta.ended_at = event.ts;
        break;

      case 'tool.called':
        updatedMeta.tool_call_count = meta.tool_call_count + 1;
        break;

      case 'tool.result':
        // Tool result doesn't change meta
        break;
    }

    return updatedMeta;
  }

  /**
   * Load cached RunMeta from file
   * @returns RunMeta or null if not found
   */
  async loadRunMeta(): Promise<RunMeta | null> {
    try {
      const content = await fs.promises.readFile(this.runMetaPath, 'utf-8');
      const parsed = JSON.parse(content) as unknown;
      const result = RunMetaSchema.safeParse(parsed);

      if (!result.success) {
        throw new ProjectionStoreError('Invalid run meta format in file', {
          filePath: this.runMetaPath,
          errors: result.error.errors,
        });
      }

      return result.data;
    } catch (error) {
      if (error instanceof ProjectionStoreError) {
        throw error;
      }
      // File not found - return null
      if (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return null;
      }
      throw new ProjectionStoreError('Failed to load run meta', {
        filePath: this.runMetaPath,
        originalError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Save RunMeta to file
   */
  private async saveRunMeta(meta: RunMeta): Promise<void> {
    // Validate before saving
    const result = RunMetaSchema.safeParse(meta);
    if (!result.success) {
      throw new ProjectionStoreError('Invalid run meta format', {
        errors: result.error.errors,
        runId: meta.run_id,
      });
    }

    await this.ensureProjectionsDir();
    const content = JSON.stringify(meta, null, 2);
    await fs.promises.writeFile(this.runMetaPath, content, {
      encoding: 'utf-8',
    });
  }

  /**
   * Check if run meta file exists
   */
  async exists(): Promise<boolean> {
    try {
      await fs.promises.access(this.runMetaPath, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete the run meta file
   */
  async delete(): Promise<void> {
    try {
      await fs.promises.unlink(this.runMetaPath);
    } catch (error) {
      // Ignore if file doesn't exist
      if (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return;
      }
      throw new ProjectionStoreError('Failed to delete run meta', {
        filePath: this.runMetaPath,
        originalError: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

