import { createHash } from 'node:crypto';
import type { FeishuChunkingConfig } from '@openintern/types/feishu.js';

export interface NormalizedChunk {
  text: string;
  snippet: string;
  chunk_type:
    | 'text'
    | 'list'
    | 'code'
    | 'table'
    | 'image'
    | 'file'
    | 'whiteboard'
    | 'embed'
    | 'media_context'
    | 'schema'
    | 'record';
  title_path: string[];
  block_ids: string[];
  metadata: Record<string, unknown>;
}

export interface NormalizedDocument {
  text: string;
  chunks: NormalizedChunk[];
  content_hash: string;
}

type SegmentKind =
  | 'text'
  | 'list'
  | 'code'
  | 'table'
  | 'image'
  | 'file'
  | 'whiteboard'
  | 'embed'
  | 'heading';

interface Segment {
  kind: SegmentKind;
  text: string;
  titlePath: string[];
  blockId: string | null;
  metadata: Record<string, unknown>;
}

interface DocxBlock {
  block_id: string | null;
  data: Record<string, unknown>;
}

interface ChunkBuildContext {
  targetChars: number;
  maxChars: number;
  minChars: number;
  mediaContextBlocks: number;
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

function buildSnippet(text: string, maxLen: number = 180): string {
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, maxLen).trim()}...`;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isMergeable(kind: SegmentKind): boolean {
  return kind === 'text' || kind === 'list' || kind === 'heading';
}

function toChunkSettings(config: FeishuChunkingConfig): ChunkBuildContext {
  // 这里用字符近�?token，保证切分行为稳定且易调�?
  return {
    targetChars: config.target_tokens,
    maxChars: config.max_tokens,
    minChars: config.min_tokens,
    mediaContextBlocks: config.media_context_blocks,
  };
}

function extractElementText(element: Record<string, unknown>): string {
  const textRun = asRecord(element['text_run']);
  const textRunContent = readString(textRun['content']);
  if (textRunContent) {
    return textRunContent;
  }

  const equation = asRecord(element['equation']);
  const equationContent = readString(equation['content']);
  if (equationContent) {
    return equationContent;
  }

  const mentionUser = asRecord(element['mention_user']);
  const mentionUserName = readString(mentionUser['name']) ?? readString(mentionUser['en_name']);
  if (mentionUserName) {
    return `@${mentionUserName}`;
  }

  const mentionDoc = asRecord(element['mention_doc']);
  const mentionDocTitle = readString(mentionDoc['title']) ?? readString(mentionDoc['url']);
  if (mentionDocTitle) {
    return mentionDocTitle;
  }

  const reminder = asRecord(element['reminder']);
  const reminderText = readString(reminder['text']);
  if (reminderText) {
    return reminderText;
  }

  const fallbackText = readString(element['text']) ?? readString(element['content']);
  if (fallbackText) {
    return fallbackText;
  }

  return '';
}

function extractRichText(payload: Record<string, unknown>): string {
  const elements = asArray(payload['elements']);
  if (elements.length === 0) {
    return (
      readString(payload['text']) ??
      readString(payload['content']) ??
      readString(payload['title']) ??
      ''
    );
  }

  const pieces: string[] = [];
  for (const value of elements) {
    const element = asRecord(value);
    const text = extractElementText(element);
    if (text) {
      pieces.push(text);
    }
  }
  return pieces.join('');
}

function toDocxBlock(rawBlock: unknown): DocxBlock {
  const block = asRecord(rawBlock);
  return {
    block_id: readString(block['block_id']),
    data: block,
  };
}

function detectPayload(block: Record<string, unknown>): {
  kind: SegmentKind;
  headingLevel: number | null;
  payload: Record<string, unknown>;
} | null {
  for (let i = 1; i <= 9; i++) {
    const key = `heading${i}`;
    if (block[key] !== undefined) {
      return {
        kind: 'heading',
        headingLevel: i,
        payload: asRecord(block[key]),
      };
    }
  }

  const mappings: Array<{ key: string; kind: SegmentKind }> = [
    { key: 'text', kind: 'text' },
    { key: 'bullet', kind: 'list' },
    { key: 'ordered', kind: 'list' },
    { key: 'quote', kind: 'text' },
    { key: 'callout', kind: 'text' },
    { key: 'todo', kind: 'list' },
    { key: 'code', kind: 'code' },
    { key: 'table', kind: 'table' },
    { key: 'image', kind: 'image' },
    { key: 'file', kind: 'file' },
    { key: 'whiteboard', kind: 'whiteboard' },
    { key: 'diagram', kind: 'embed' },
    { key: 'mindnote', kind: 'embed' },
    { key: 'iframe', kind: 'embed' },
    { key: 'sheet', kind: 'embed' },
    { key: 'isv', kind: 'embed' },
  ];

  for (const item of mappings) {
    if (block[item.key] !== undefined) {
      return {
        kind: item.kind,
        headingLevel: null,
        payload: asRecord(block[item.key]),
      };
    }
  }

  return null;
}

function buildDocxSegments(params: {
  title: string;
  blocks: Array<Record<string, unknown>>;
}): Segment[] {
  const segments: Segment[] = [];
  const headingStack: string[] = [params.title];

  for (const rawBlock of params.blocks) {
    const block = toDocxBlock(rawBlock);
    const detected = detectPayload(block.data);
    if (!detected) {
      continue;
    }

    if (detected.headingLevel !== null) {
      const headingText = normalizeWhitespace(extractRichText(detected.payload));
      if (!headingText) {
        continue;
      }
      const depth = Math.max(1, detected.headingLevel);
      headingStack.splice(depth);
      headingStack[depth] = headingText;
      segments.push({
        kind: 'heading',
        text: headingText,
        titlePath: headingStack.filter((item) => item && item.trim()),
        blockId: block.block_id,
        metadata: { heading_level: depth },
      });
      continue;
    }

    const basePath = headingStack.filter((item) => item && item.trim());
    const text = normalizeWhitespace(extractRichText(detected.payload));

    if (detected.kind === 'text' || detected.kind === 'list') {
      if (!text) {
        continue;
      }
      const prefix = detected.kind === 'list' ? '- ' : '';
      segments.push({
        kind: detected.kind,
        text: `${prefix}${text}`,
        titlePath: basePath,
        blockId: block.block_id,
        metadata: {},
      });
      continue;
    }

    if (detected.kind === 'code') {
      if (!text) {
        continue;
      }
      const language =
        readString(asRecord(detected.payload['style'])['language']) ??
        readString(detected.payload['language']) ??
        '';
      const fenced = language ? `\`\`\`${language}\n${text}\n\`\`\`` : `\`\`\`\n${text}\n\`\`\``;
      segments.push({
        kind: 'code',
        text: fenced,
        titlePath: basePath,
        blockId: block.block_id,
        metadata: language ? { language } : {},
      });
      continue;
    }

    if (detected.kind === 'table') {
      const rowSize = Number(asRecord(detected.payload)['row_size'] ?? 0);
      const columnSize = Number(asRecord(detected.payload)['column_size'] ?? 0);
      const tableText = text || `表格 ${rowSize || '?'} x ${columnSize || '?'}`;
      segments.push({
        kind: 'table',
        text: tableText,
        titlePath: basePath,
        blockId: block.block_id,
        metadata: {
          row_size: Number.isFinite(rowSize) ? rowSize : null,
          column_size: Number.isFinite(columnSize) ? columnSize : null,
        },
      });
      continue;
    }

    if (detected.kind === 'image') {
      const token = readString(detected.payload['token']) ?? readString(detected.payload['file_token']);
      const width = Number(detected.payload['width'] ?? 0);
      const height = Number(detected.payload['height'] ?? 0);
      segments.push({
        kind: 'image',
        text: `【图片】${text || '无图'}`,
        titlePath: basePath,
        blockId: block.block_id,
        metadata: {
          token,
          width: Number.isFinite(width) && width > 0 ? width : null,
          height: Number.isFinite(height) && height > 0 ? height : null,
        },
      });
      continue;
    }

    if (detected.kind === 'file') {
      const token = readString(detected.payload['token']) ?? readString(detected.payload['file_token']);
      const name = readString(detected.payload['name']);
      segments.push({
        kind: 'file',
        text: `【附件】${name ?? '未命名附件'}`,
        titlePath: basePath,
        blockId: block.block_id,
        metadata: {
          token,
          name,
        },
      });
      continue;
    }

    if (detected.kind === 'whiteboard') {
      const token =
        readString(detected.payload['token']) ??
        readString(detected.payload['whiteboard_id']) ??
        readString(detected.payload['id']);
      segments.push({
        kind: 'whiteboard',
        text: `【画板】${text || token || 'whiteboard'}`,
        titlePath: basePath,
        blockId: block.block_id,
        metadata: {
          token,
        },
      });
      continue;
    }

    if (detected.kind === 'embed') {
      const url = readString(detected.payload['url']) ?? readString(detected.payload['src']);
      const token = readString(detected.payload['token']) ?? readString(detected.payload['id']);
      segments.push({
        kind: 'embed',
        text: `【嵌入内容】${text || url || token || 'embed'}`,
        titlePath: basePath,
        blockId: block.block_id,
        metadata: {
          url,
          token,
        },
      });
    }
  }

  return segments;
}

function mapSegmentKindToChunkType(kind: SegmentKind): NormalizedChunk['chunk_type'] {
  switch (kind) {
    case 'list':
      return 'list';
    case 'code':
      return 'code';
    case 'table':
      return 'table';
    case 'image':
      return 'image';
    case 'file':
      return 'file';
    case 'whiteboard':
      return 'whiteboard';
    case 'embed':
      return 'embed';
    case 'heading':
    case 'text':
    default:
      return 'text';
  }
}

function buildChunksFromSegments(segments: Segment[], context: ChunkBuildContext): NormalizedChunk[] {
  const chunks: NormalizedChunk[] = [];
  const pushChunk = (input: {
    text: string;
    kind: NormalizedChunk['chunk_type'];
    titlePath: string[];
    blockIds: string[];
    metadata?: Record<string, unknown>;
  }): void => {
    const cleaned = normalizeWhitespace(input.text);
    if (!cleaned) {
      return;
    }
    chunks.push({
      text: cleaned,
      snippet: buildSnippet(cleaned),
      chunk_type: input.kind,
      title_path: input.titlePath,
      block_ids: input.blockIds,
      metadata: input.metadata ?? {},
    });
  };

  let buffer: Segment[] = [];
  let bufferChars = 0;
  const flushBuffer = (): void => {
    if (buffer.length === 0) {
      return;
    }
    const text = buffer.map((item) => item.text).join('\n');
    const blockIds = buffer
      .map((item) => item.blockId)
      .filter((item): item is string => typeof item === 'string');
    const last = buffer[buffer.length - 1];
    pushChunk({
      text,
      kind: buffer.every((item) => item.kind === 'list') ? 'list' : 'text',
      titlePath: last?.titlePath ?? [],
      blockIds,
      metadata: {
        block_count: buffer.length,
      },
    });
    buffer = [];
    bufferChars = 0;
  };

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (!segment) {
      continue;
    }

    if (isMergeable(segment.kind)) {
      if (
        bufferChars >= context.minChars &&
        bufferChars + segment.text.length + 1 > context.maxChars
      ) {
        flushBuffer();
      }
      buffer.push(segment);
      bufferChars += segment.text.length + 1;
      if (bufferChars >= context.targetChars) {
        flushBuffer();
      }
      continue;
    }

    flushBuffer();
    pushChunk({
      text: segment.text,
      kind: mapSegmentKindToChunkType(segment.kind),
      titlePath: segment.titlePath,
      blockIds: segment.blockId ? [segment.blockId] : [],
      metadata: segment.metadata,
    });

    if (
      segment.kind === 'image' ||
      segment.kind === 'file' ||
      segment.kind === 'whiteboard' ||
      segment.kind === 'embed'
    ) {
      const prev: Segment[] = [];
      const next: Segment[] = [];
      for (let offset = 1; offset <= context.mediaContextBlocks; offset++) {
        const prevSeg = segments[i - offset];
        if (prevSeg && isMergeable(prevSeg.kind)) {
          prev.unshift(prevSeg);
        }
        const nextSeg = segments[i + offset];
        if (nextSeg && isMergeable(nextSeg.kind)) {
          next.push(nextSeg);
        }
      }

      const related = [...prev, ...next];
      const relatedText = related.map((item) => item.text).join('\n');
      if (normalizeWhitespace(relatedText)) {
        pushChunk({
          text: `【媒体上下文】${relatedText}`,
          kind: 'media_context',
          titlePath: segment.titlePath,
          blockIds: [
            ...(segment.blockId ? [segment.blockId] : []),
            ...related
              .map((item) => item.blockId)
              .filter((item): item is string => typeof item === 'string'),
          ],
          metadata: {
            media_type: segment.kind,
            media_block_id: segment.blockId,
          },
        });
      }
    }
  }

  flushBuffer();
  return chunks;
}

function buildDocumentText(chunks: NormalizedChunk[], fallbackText: string | null): string {
  const joined = chunks.map((item) => item.text).join('\n\n').trim();
  if (joined) {
    return joined;
  }
  return normalizeWhitespace(fallbackText ?? '');
}

function hashContent(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function normalizeDocxToChunks(input: {
  title: string;
  blocks: Array<Record<string, unknown>>;
  rawContent: string | null;
  chunking: FeishuChunkingConfig;
}): NormalizedDocument {
  const settings = toChunkSettings(input.chunking);
  const segments = buildDocxSegments({
    title: input.title,
    blocks: input.blocks,
  });
  const chunks = buildChunksFromSegments(segments, settings);
  const text = buildDocumentText(chunks, input.rawContent);
  return {
    text,
    chunks,
    content_hash: hashContent(text),
  };
}

function valueToReadableText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => valueToReadableText(item))
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .join('; ');
  }
  if (typeof value === 'object') {
    const record = asRecord(value);
    const directText =
      readString(record['text']) ??
      readString(record['name']) ??
      readString(record['title']) ??
      readString(record['value']);
    if (directText) {
      return directText;
    }
    return JSON.stringify(record);
  }
  return '';
}

function chunkTextLines(
  lines: string[],
  config: FeishuChunkingConfig,
  chunkType: NormalizedChunk['chunk_type'],
  metadata: Record<string, unknown>
): NormalizedChunk[] {
  const chunks: NormalizedChunk[] = [];
  const settings = toChunkSettings(config);
  let buffer = '';
  let start = 0;

  const push = (end: number): void => {
    const text = normalizeWhitespace(buffer);
    if (!text) {
      return;
    }
    chunks.push({
      text,
      snippet: buildSnippet(text),
      chunk_type: chunkType,
      title_path: [],
      block_ids: [],
      metadata: {
        ...metadata,
        line_range: `${start + 1}-${end + 1}`,
      },
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) {
      continue;
    }
    const next = buffer ? `${buffer}\n${line}` : line;
    if (buffer && next.length > settings.maxChars) {
      push(i - 1);
      buffer = line;
      start = i;
      continue;
    }
    buffer = next;
    if (buffer.length >= settings.targetChars) {
      push(i);
      buffer = '';
      start = i + 1;
    }
  }

  if (buffer) {
    push(lines.length - 1);
  }
  return chunks;
}

export function normalizeBitableTableToChunks(input: {
  appToken: string;
  appName: string;
  tableId: string;
  tableName: string;
  fields: Array<Record<string, unknown>>;
  records: Array<Record<string, unknown>>;
  chunking: FeishuChunkingConfig;
}): NormalizedDocument {
  const schemaLines: string[] = [
    `多维表格: ${input.appName} (${input.appToken})`,
    `数据�? ${input.tableName} (${input.tableId})`,
    '字段定义:',
  ];
  for (const field of input.fields) {
    const name = readString(field['field_name']) ?? readString(field['name']) ?? '未命名字段';
    const type = readString(field['type']) ?? String(field['type'] ?? 'unknown');
    schemaLines.push(`- ${name} [${type}]`);
  }

  const chunks: NormalizedChunk[] = [];
  const schemaText = schemaLines.join('\n');
  chunks.push({
    text: schemaText,
    snippet: buildSnippet(schemaText),
    chunk_type: 'schema',
    title_path: [input.appName, input.tableName],
    block_ids: [],
    metadata: {
      app_token: input.appToken,
      table_id: input.tableId,
      field_count: input.fields.length,
      record_count: input.records.length,
    },
  });

  const recordLines: string[] = [];
  for (const record of input.records) {
    const recordId =
      readString(record['record_id']) ??
      readString(record['recordId']) ??
      readString(record['id']) ??
      'record';
    const fields = asRecord(record['fields']);

    const parts: string[] = [];
    for (const [fieldName, fieldValue] of Object.entries(fields)) {
      const readable = valueToReadableText(fieldValue);
      if (!readable) {
        continue;
      }
      if (readable.length >= 24) {
        parts.push(`${fieldName}: ${readable}`);
      }
    }
    if (parts.length === 0) {
      const short = Object.entries(fields)
        .map(([fieldName, fieldValue]) => {
          const readable = valueToReadableText(fieldValue);
          return readable ? `${fieldName}: ${readable}` : '';
        })
        .filter((item) => item.length > 0)
        .slice(0, 3);
      parts.push(...short);
    }
    if (parts.length === 0) {
      continue;
    }
    recordLines.push(`记录 ${recordId}`);
    for (const part of parts) {
      recordLines.push(`- ${part}`);
    }
  }

  const recordChunks = chunkTextLines(recordLines, input.chunking, 'record', {
    app_token: input.appToken,
    table_id: input.tableId,
    table_name: input.tableName,
  });
  for (const item of recordChunks) {
    chunks.push({
      ...item,
      title_path: [input.appName, input.tableName],
    });
  }

  const text = chunks.map((item) => item.text).join('\n\n').trim();
  return {
    text,
    chunks,
    content_hash: hashContent(text),
  };
}
