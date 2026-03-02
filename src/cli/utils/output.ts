/**
 * CLI Output Utilities
 *
 * Provides formatted output helpers for CLI commands.
 */

/* eslint-disable no-console */

import chalk from 'chalk';
import Table from 'cli-table3';

/**
 * Print a success message with checkmark
 */
export function success(message: string): void {
  console.log(chalk.green('✓') + ' ' + message);
}

/**
 * Print an error message with X mark
 */
export function error(message: string): void {
  console.log(chalk.red('✗') + ' ' + message);
}

/**
 * Print a warning message
 */
export function warn(message: string): void {
  console.log(chalk.yellow('⚠') + ' ' + message);
}

/**
 * Print an info message
 */
export function info(message: string): void {
  console.log(chalk.blue('ℹ') + ' ' + message);
}

/**
 * Print a plain message
 */
export function print(message: string): void {
  console.log(message);
}

/**
 * Print a header
 */
export function header(title: string): void {
  console.log();
  console.log(chalk.bold(title));
  console.log();
}

/**
 * Print a key-value pair
 */
export function keyValue(key: string, value: string): void {
  console.log(chalk.gray(key + ':') + ' ' + value);
}

/**
 * Format a timestamp for display
 */
export function formatTimestamp(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleTimeString('en-US', { hour12: false });
}

/**
 * Format duration in milliseconds
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Create a table with the given headers
 */
export function createTable(headers: string[]): Table.Table {
  return new Table({
    head: headers.map((h) => chalk.cyan(h)),
    style: {
      head: [],
      border: [],
    },
  });
}

/**
 * Print JSON output
 */
export function json(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Print a spinner-like progress indicator
 */
export function progress(message: string): void {
  process.stdout.write(chalk.gray('→ ') + message + '...');
}

/**
 * Clear the current line and print done
 */
export function progressDone(): void {
  process.stdout.write(' ' + chalk.green('done') + '\n');
}

/**
 * Clear the current line and print failed
 */
export function progressFailed(): void {
  process.stdout.write(' ' + chalk.red('failed') + '\n');
}

/**
 * Event type colors for pretty printing
 */
const EVENT_COLORS: Record<string, (s: string) => string> = {
  'run.started': chalk.green,
  'run.completed': chalk.green,
  'run.failed': chalk.red,
  'step.started': chalk.blue,
  'step.completed': chalk.blue,
  'tool.hint': chalk.yellow,
  'tool.called': chalk.yellow,
  'tool.result': chalk.yellow,
  'llm.called': chalk.magenta,
};

/**
 * Format an event for pretty printing
 */
export function formatEvent(event: {
  ts: string;
  type: string;
  step_id?: string;
  payload?: Record<string, unknown>;
}): string {
  const time = formatTimestamp(event.ts);
  const colorFn = EVENT_COLORS[event.type] ?? chalk.white;
  const typeStr = colorFn(event.type);

  let details = '';
  if (event.payload) {
    if (event.type === 'tool.called' && 'toolName' in event.payload) {
      details = `: ${String(event.payload['toolName'])}`;
    } else if (event.type === 'tool.hint' && 'hint' in event.payload) {
      details = `: ${String(event.payload['hint'])}`;
    } else if (event.type === 'tool.result' && 'toolName' in event.payload) {
      const isError = event.payload['isError'];
      const toolName = String(event.payload['toolName']);
      details = isError
        ? `: ${toolName} ${chalk.red('(error)')}`
        : `: ${toolName}`;
    } else if (event.type === 'step.started' || event.type === 'step.completed') {
      details = ` (${event.step_id ?? ''})`;
    } else if (event.type === 'run.completed' && 'duration_ms' in event.payload) {
      details = ` in ${formatDuration(event.payload['duration_ms'] as number)}`;
    } else if (event.type === 'run.failed' && 'error' in event.payload) {
      const err = event.payload['error'] as { message?: string };
      details = `: ${err.message ?? 'Unknown error'}`;
    }
  }

  return `[${chalk.gray(time)}] ${typeStr}${details}`;
}
