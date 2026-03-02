/**
 * EventStore - Append-only event log with JSONL format + indexing
 *
 * Storage:
 * - data/sessions/<session_key>/runs/<run_id>/events.jsonl (append-only)
 * - data/sessions/<session_key>/runs/<run_id>/events.idx.jsonl (index)
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { EventSchema, type Event } from '@openintern/types/events.js';
import { EventStoreError } from '@openintern/utils';
import { logger } from '@openintern/utils';

/**
 * Index entry for pagination
 */
export interface IndexEntry {
  /** Byte offset in the file */
  offset: number;
  /** Line number (0-based) */
  line: number;
  /** Timestamp of the event at this position */
  ts: string;
}

/**
 * EventStore class for managing append-only event logs
 */
export class EventStore {
  private readonly eventsPath: string;
  private readonly indexPath: string;
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
    this.eventsPath = path.join(runDir, 'events.jsonl');
    this.indexPath = path.join(runDir, 'events.idx.jsonl');
  }

  /**
   * Get the events file path
   */
  getEventsPath(): string {
    return this.eventsPath;
  }

  /**
   * Get the index file path
   */
  getIndexPath(): string {
    return this.indexPath;
  }

  /**
   * Ensure the directory exists
   */
  private async ensureDir(): Promise<void> {
    const dir = path.dirname(this.eventsPath);
    await fs.promises.mkdir(dir, { recursive: true });
  }

  /**
   * Validate an event using Zod schema
   */
  private validateEvent(event: Event): void {
    const result = EventSchema.safeParse(event);
    if (!result.success) {
      throw new EventStoreError('Invalid event format', {
        errors: result.error.errors,
        eventType: event.type,
      });
    }
  }

  /**
   * Append a single event to the log
   */
  async append(event: Event): Promise<void> {
    // Validate event
    this.validateEvent(event);

    // Use lock to ensure single-writer principle
    this.writeLock = this.writeLock.then(async () => {
      try {
        await this.ensureDir();
        const line = JSON.stringify(event) + '\n';
        await fs.promises.appendFile(this.eventsPath, line, {
          encoding: 'utf-8',
        });
      } catch (error) {
        throw new EventStoreError('Failed to append event', {
          filePath: this.eventsPath,
          eventType: event.type,
          originalError: error instanceof Error ? error.message : String(error),
        });
      }
    });

    await this.writeLock;
  }

  /**
   * Append multiple events atomically
   */
  async appendBatch(events: Event[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    // Validate all events first
    for (const event of events) {
      this.validateEvent(event);
    }

    // Use lock to ensure single-writer principle
    this.writeLock = this.writeLock.then(async () => {
      try {
        await this.ensureDir();
        const lines = events.map((e) => JSON.stringify(e) + '\n').join('');
        await fs.promises.appendFile(this.eventsPath, lines, {
          encoding: 'utf-8',
        });
      } catch (error) {
        throw new EventStoreError('Failed to append batch', {
          filePath: this.eventsPath,
          eventCount: events.length,
          originalError: error instanceof Error ? error.message : String(error),
        });
      }
    });

    await this.writeLock;
  }

  /**
   * Stream all events from the log
   */
  async *readStream(): AsyncGenerator<Event> {
    // Check if file exists
    try {
      await fs.promises.access(this.eventsPath, fs.constants.R_OK);
    } catch {
      // File doesn't exist, return empty
      return;
    }

    const fileStream = fs.createReadStream(this.eventsPath, {
      encoding: 'utf-8',
    });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    try {
      for await (const line of rl) {
        if (!line.trim()) {
          continue;
        }
        try {
          const parsed = JSON.parse(line) as unknown;
          const result = EventSchema.safeParse(parsed);
          if (result.success) {
            yield result.data;
          } else {
            // Log warning but continue (resilient to corrupted lines)
            logger.warn('Failed to validate event line', { line, errors: result.error.errors });
          }
        } catch (error) {
          // Log warning but continue (resilient to corrupted lines)
          logger.warn('Failed to parse event line', { line, error });
        }
      }
    } finally {
      rl.close();
      fileStream.destroy();
    }
  }

  /**
   * Read all events from the log
   */
  async readAll(): Promise<Event[]> {
    const events: Event[] = [];
    for await (const event of this.readStream()) {
      events.push(event);
    }
    return events;
  }

  /**
   * Read events matching a predicate
   */
  async readFiltered(predicate: (event: Event) => boolean): Promise<Event[]> {
    const events: Event[] = [];
    for await (const event of this.readStream()) {
      if (predicate(event)) {
        events.push(event);
      }
    }
    return events;
  }

  /**
   * Read a page of events
   */
  async readPage(pageSize: number = 100, offset: number = 0): Promise<Event[]> {
    const events: Event[] = [];
    let currentLine = 0;

    for await (const event of this.readStream()) {
      if (currentLine >= offset && events.length < pageSize) {
        events.push(event);
      }
      currentLine++;
      if (events.length >= pageSize) {
        break;
      }
    }

    return events;
  }

  /**
   * Build index file for pagination
   */
  async buildIndex(eventsPerEntry: number = 100): Promise<void> {
    await this.ensureDir();

    // Check if events file exists
    try {
      await fs.promises.access(this.eventsPath, fs.constants.R_OK);
    } catch {
      // No events file, create empty index
      await fs.promises.writeFile(this.indexPath, '', { encoding: 'utf-8' });
      return;
    }

    const indexEntries: string[] = [];
    let lineNumber = 0;
    let byteOffset = 0;

    const fileStream = fs.createReadStream(this.eventsPath, {
      encoding: 'utf-8',
    });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    try {
      for await (const line of rl) {
        if (!line.trim()) {
          byteOffset += Buffer.byteLength(line + '\n', 'utf-8');
          continue;
        }

        try {
          const event = JSON.parse(line) as { ts?: string };

          if (lineNumber % eventsPerEntry === 0) {
            const indexEntry: IndexEntry = {
              offset: byteOffset,
              line: lineNumber,
              ts: event.ts ?? new Date().toISOString(),
            };
            indexEntries.push(JSON.stringify(indexEntry));
          }
        } catch {
          // Skip corrupted lines
        }

        byteOffset += Buffer.byteLength(line + '\n', 'utf-8');
        lineNumber++;
      }
    } finally {
      rl.close();
      fileStream.destroy();
    }

    // Write index file
    const indexContent = indexEntries.length > 0
      ? indexEntries.join('\n') + '\n'
      : '';
    await fs.promises.writeFile(this.indexPath, indexContent, {
      encoding: 'utf-8',
    });
  }

  /**
   * Get total event count
   */
  async count(): Promise<number> {
    let count = 0;
    for await (const _event of this.readStream()) {
      void _event; // Explicitly ignore
      count++;
    }
    return count;
  }

  /**
   * Check if events file exists
   */
  async exists(): Promise<boolean> {
    try {
      await fs.promises.access(this.eventsPath, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }
}

