/**
 * CLI Command: agent export
 *
 * Export events from a run to file
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventStore } from '../../backend/store/event-store.js';
import type { Event } from '@openintern/types/events.js';
import * as output from '../utils/output.js';

export interface ExportOptions {
  out: string | undefined;
  format: 'jsonl' | 'json';
  filter: string | undefined;
  session: string;
}

/**
 * Execute the export command
 */
export async function exportCommand(
  runId: string,
  options: ExportOptions
): Promise<void> {
  // Validate run_id format
  if (!runId.startsWith('run_')) {
    output.error('Invalid run_id format. Expected: run_<id>');
    process.exit(1);
  }

  const sessionKey = options.session.startsWith('s_')
    ? options.session
    : `s_${options.session}`;

  const baseDir = process.env['DATA_DIR'] ?? 'data';
  const eventStore = new EventStore(sessionKey, runId, baseDir);

  try {
    // Check if events file exists
    const exists = await eventStore.exists();
    if (!exists) {
      output.error(`Run not found: ${runId}`);
      output.info(`Session: ${sessionKey}`);
      output.info(`Path: ${eventStore.getEventsPath()}`);
      process.exit(1);
    }

    output.progress('Reading events');

    // Read and filter events
    const events: Event[] = [];
    for await (const event of eventStore.readStream()) {
      if (options.filter && event.type !== options.filter) {
        continue;
      }
      events.push(event);
    }

    output.progressDone();

    if (events.length === 0) {
      output.warn('No events found');
      if (options.filter) {
        output.info(`Filter: ${options.filter}`);
      }
      return;
    }

    // Format output
    let content: string;
    if (options.format === 'json') {
      content = JSON.stringify(events, null, 2);
    } else {
      content = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    }

    // Write to file or stdout
    if (options.out) {
      const outPath = path.resolve(options.out);
      await fs.promises.writeFile(outPath, content, 'utf-8');
      output.success(`Exported ${events.length} events to ${outPath}`);
    } else {
      output.print(content);
    }
  } catch (err) {
    output.error(
      `Export failed: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }
}
