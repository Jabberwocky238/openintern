import { execFile } from 'node:child_process';
import { ToolError } from '@openintern/utils';

const READ_FILE_MAX_CHARS = 120_000;
const TRAILING_WHITESPACE_REGEX = /[ \t]+$/u;

export interface NormalizedText {
  text: string;
  boundaries: number[];
}

export function truncateContent(content: string): {
  content: string;
  truncated: boolean;
  originalLength: number;
} {
  if (content.length <= READ_FILE_MAX_CHARS) {
    return { content, truncated: false, originalLength: content.length };
  }
  return {
    content: `${content.slice(0, READ_FILE_MAX_CHARS)}\n\n[truncated: original_length=${content.length}]`,
    truncated: true,
    originalLength: content.length,
  };
}

async function tryExtractPdfWithPdftotext(resolvedPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'pdftotext',
      ['-enc', 'UTF-8', '-layout', resolvedPath, '-'],
      { timeout: 20_000, maxBuffer: 1024 * 1024 * 10 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const text = stdout.trim();
        resolve(text.length > 0 ? text : null);
      },
    );
  });
}

async function tryExtractPdfWithStrings(resolvedPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'strings',
      ['-n', '6', resolvedPath],
      { timeout: 20_000, maxBuffer: 1024 * 1024 * 10 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const lines = stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        const text = lines.join('\n');
        resolve(text.length > 0 ? text : null);
      },
    );
  });
}

export async function extractPdfText(
  resolvedPath: string
): Promise<{ content: string; method: 'pdftotext' | 'strings' }> {
  const byPdftotext = await tryExtractPdfWithPdftotext(resolvedPath);
  if (byPdftotext) {
    return { content: byPdftotext, method: 'pdftotext' };
  }
  const byStrings = await tryExtractPdfWithStrings(resolvedPath);
  if (byStrings) {
    return { content: byStrings, method: 'strings' };
  }
  throw new ToolError(
    'Failed to extract readable text from PDF. Try mineru_ingest_pdf for structured PDF parsing.',
    'read_file'
  );
}

function normalizeLineEndings(input: string): string {
  return input.replace(/\r\n?/g, '\n');
}

function trimLineRight(input: string): string {
  return input
    .split('\n')
    .map((line) => line.replace(TRAILING_WHITESPACE_REGEX, ''))
    .join('\n');
}

export function normalizeBlockForMatch(input: string): string {
  return trimLineRight(normalizeLineEndings(input));
}

export function normalizeFileForMatch(content: string): NormalizedText {
  let cursor = 0;
  let normalized = '';
  const boundaries = [0];

  while (cursor < content.length) {
    const lineStart = cursor;
    while (cursor < content.length && content[cursor] !== '\n' && content[cursor] !== '\r') {
      cursor++;
    }

    const lineEnd = cursor;
    const normalizedLine = content.slice(lineStart, lineEnd).replace(TRAILING_WHITESPACE_REGEX, '');
    for (let i = 0; i < normalizedLine.length; i++) {
      normalized += normalizedLine[i];
      boundaries.push(lineStart + i + 1);
    }

    if (cursor < content.length) {
      const newlineLength = content[cursor] === '\r' && content[cursor + 1] === '\n' ? 2 : 1;
      normalized += '\n';
      boundaries.push(lineEnd + newlineLength);
      cursor = lineEnd + newlineLength;
      continue;
    }

    cursor = lineEnd;
  }

  return { text: normalized, boundaries };
}

export function findMatchOffsets(haystack: string, needle: string): number[] {
  if (needle.length === 0) return [];
  const offsets: number[] = [];
  let fromIndex = 0;
  while (fromIndex <= haystack.length - needle.length) {
    const offset = haystack.indexOf(needle, fromIndex);
    if (offset === -1) break;
    offsets.push(offset);
    fromIndex = offset + 1;
  }
  return offsets;
}

export function resolveRawOffsets(
  boundaries: number[],
  normalizedStart: number,
  normalizedLength: number
): { start: number; end: number } {
  const normalizedEnd = normalizedStart + normalizedLength;
  const start = boundaries[normalizedStart];
  const end = boundaries[normalizedEnd];
  if (typeof start !== 'number' || typeof end !== 'number' || start > end) {
    throw new ToolError('Failed to map normalized match back to raw file offsets', 'replace_in_file');
  }
  return { start, end };
}

export function buildReplaceInFileError(matchCount: number): string {
  const guidance = 'Expand unchanged context before/after the target lines and preserve leading indentation exactly.';
  if (matchCount === 0) {
    return `search_block did not match exactly once after newline + trailing-space normalization (matches=0). ${guidance}`;
  }
  return `search_block must match exactly once after normalization (matches=${matchCount}). ${guidance}`;
}

