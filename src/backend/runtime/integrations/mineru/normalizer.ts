import { createHash } from 'node:crypto';

export interface MineruNormalizedChunk {
  text: string;
  snippet: string;
  chunk_type: 'text' | 'table' | 'image' | 'equation' | 'meta';
  title_path: string[];
  block_ids: string[];
  metadata: Record<string, unknown>;
}

export interface MineruNormalizedDocument {
  text: string;
  chunks: MineruNormalizedChunk[];
  content_hash: string;
}

interface ChunkSettings {
  targetChars: number;
  maxChars: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function buildSnippet(text: string): string {
  if (text.length <= 180) {
    return text;
  }
  return `${text.slice(0, 180).trim()}...`;
}

function collectStringValues(value: unknown, depth: number = 0): string[] {
  if (depth > 5) {
    return [];
  }
  if (typeof value === 'string') {
    const normalized = normalizeWhitespace(value);
    return normalized ? [normalized] : [];
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      parts.push(...collectStringValues(item, depth + 1));
    }
    return parts;
  }
  if (value && typeof value === 'object') {
    const record = asRecord(value);
    const parts: string[] = [];
    for (const child of Object.values(record)) {
      parts.push(...collectStringValues(child, depth + 1));
    }
    return parts;
  }
  return [];
}

function extractItemText(item: Record<string, unknown>): string {
  const preferredFields = [
    'text',
    'content',
    'title',
    'caption',
    'equation',
    'latex',
    'html',
    'table_caption',
    'code',
  ];
  const collected: string[] = [];
  for (const key of preferredFields) {
    if (!(key in item)) {
      continue;
    }
    collected.push(...collectStringValues(item[key]));
  }

  if (collected.length === 0) {
    collected.push(...collectStringValues(item));
  }

  const joined = normalizeWhitespace(collected.join(' '));
  if (!joined) {
    return '';
  }
  if (joined.length > 4000) {
    return joined.slice(0, 4000);
  }
  return joined;
}

function mapItemType(itemType: string | null): MineruNormalizedChunk['chunk_type'] {
  const normalized = (itemType ?? '').toLowerCase();
  if (normalized.includes('table')) {
    return 'table';
  }
  if (normalized.includes('image') || normalized.includes('figure') || normalized.includes('pic')) {
    return 'image';
  }
  if (normalized.includes('equation') || normalized.includes('formula') || normalized.includes('latex')) {
    return 'equation';
  }
  if (normalized.includes('title') || normalized.includes('header') || normalized.includes('footer')) {
    return 'meta';
  }
  return 'text';
}

function splitChunkText(text: string, settings: ChunkSettings): string[] {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return [];
  }
  if (normalized.length <= settings.maxChars) {
    return [normalized];
  }

  const words = normalized.split(' ');
  const chunks: string[] = [];
  let buffer = '';
  for (const word of words) {
    const next = buffer ? `${buffer} ${word}` : word;
    if (buffer && next.length > settings.maxChars) {
      chunks.push(buffer);
      buffer = word;
      continue;
    }
    buffer = next;
    if (buffer.length >= settings.targetChars) {
      chunks.push(buffer);
      buffer = '';
    }
  }
  if (buffer) {
    chunks.push(buffer);
  }
  return chunks;
}

function hashContent(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function normalizeMineruOutputToChunks(input: {
  title: string;
  markdown: string | null;
  contentList: unknown;
  chunking?: {
    target_chars?: number;
    max_chars?: number;
  };
}): MineruNormalizedDocument {
  const settings: ChunkSettings = {
    targetChars: Math.max(300, Math.min(input.chunking?.target_chars ?? 1200, 4000)),
    maxChars: Math.max(400, Math.min(input.chunking?.max_chars ?? 1800, 6000)),
  };
  const titlePath = [input.title];

  const chunks: MineruNormalizedChunk[] = [];
  const list = asArray(input.contentList);
  if (list.length > 0) {
    for (let i = 0; i < list.length; i++) {
      const raw = list[i];
      const item = asRecord(raw);
      const itemType = readString(item['type']);
      const pageIdx = readNumber(item['page_idx']) ?? readNumber(item['page_index']);
      const baseText = extractItemText(item);
      if (!baseText) {
        continue;
      }
      const itemChunks = splitChunkText(baseText, settings);
      const mappedType = mapItemType(itemType);
      for (let chunkIndex = 0; chunkIndex < itemChunks.length; chunkIndex++) {
        const text = itemChunks[chunkIndex];
        if (!text) {
          continue;
        }
        chunks.push({
          text,
          snippet: buildSnippet(text),
          chunk_type: mappedType,
          title_path: titlePath,
          block_ids: [],
          metadata: {
            item_index: i,
            item_chunk_index: chunkIndex,
            item_type: itemType ?? 'unknown',
            ...(pageIdx !== null ? { page_idx: pageIdx } : {}),
          },
        });
      }
    }
  }

  if (chunks.length === 0) {
    const markdown = readString(input.markdown);
    if (markdown) {
      const markdownChunks = splitChunkText(markdown, settings);
      for (let i = 0; i < markdownChunks.length; i++) {
        const text = markdownChunks[i];
        if (!text) {
          continue;
        }
        chunks.push({
          text,
          snippet: buildSnippet(text),
          chunk_type: 'text',
          title_path: titlePath,
          block_ids: [],
          metadata: {
            source: 'markdown',
            markdown_chunk_index: i,
          },
        });
      }
    }
  }

  const text = chunks.map((chunk) => chunk.text).join('\n\n').trim();
  return {
    text,
    chunks,
    content_hash: hashContent(text),
  };
}

