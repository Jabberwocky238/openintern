export interface TextChunk {
  index: number;
  text: string;
  snippet: string;
}

export interface TextChunkOptions {
  chunkSize: number;
  overlap: number;
  snippetLength: number;
}

const DEFAULT_OPTIONS: TextChunkOptions = {
  chunkSize: 800,
  overlap: 120,
  snippetLength: 180,
};

function buildSnippet(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, maxLen).trim()}...`;
}

export function splitIntoChunks(
  input: string,
  options: Partial<TextChunkOptions> = {}
): TextChunk[] {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const cleaned = input.replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return [];
  }

  const chunks: TextChunk[] = [];
  let cursor = 0;
  let index = 0;
  while (cursor < cleaned.length) {
    const end = Math.min(cleaned.length, cursor + config.chunkSize);
    const chunkText = cleaned.slice(cursor, end).trim();
    if (chunkText) {
      chunks.push({
        index,
        text: chunkText,
        snippet: buildSnippet(chunkText, config.snippetLength),
      });
      index++;
    }
    if (end >= cleaned.length) {
      break;
    }
    cursor = Math.max(0, end - config.overlap);
  }
  return chunks;
}

