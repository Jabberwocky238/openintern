import { describe, expect, it } from 'vitest';
import { normalizeMineruOutputToChunks } from './normalizer.js';

describe('normalizeMineruOutputToChunks', () => {
  it('normalizes content_list items into typed chunks', () => {
    const result = normalizeMineruOutputToChunks({
      title: 'Spec PDF',
      markdown: null,
      contentList: [
        { type: 'text', text: 'Overview section content', page_idx: 1 },
        { type: 'table', content: 'col_a col_b row_1', page_index: 2 },
        { type: 'equation', latex: 'E = mc^2', page_idx: 3 },
        { type: 'image', caption: 'System architecture', page_idx: 4 },
      ],
      chunking: {
        target_chars: 120,
        max_chars: 240,
      },
    });

    expect(result.chunks.length).toBe(4);
    expect(result.chunks.map((chunk) => chunk.chunk_type)).toEqual([
      'text',
      'table',
      'equation',
      'image',
    ]);
    expect(result.chunks[0]?.title_path).toEqual(['Spec PDF']);
    expect(result.chunks[0]?.metadata).toMatchObject({
      item_index: 0,
      item_type: 'text',
      page_idx: 1,
    });
    expect(result.text).toContain('Overview section content');
    expect(result.content_hash.length).toBe(64);
  });

  it('falls back to markdown when content_list is empty', () => {
    const result = normalizeMineruOutputToChunks({
      title: 'Fallback',
      markdown: '# Header\n\nBody paragraph.',
      contentList: [],
      chunking: {
        target_chars: 120,
        max_chars: 240,
      },
    });

    expect(result.chunks.length).toBe(1);
    expect(result.chunks[0]?.metadata).toMatchObject({
      source: 'markdown',
      markdown_chunk_index: 0,
    });
    expect(result.text).toContain('Header');
  });

  it('splits long text by configured boundaries', () => {
    const repeated = new Array(120).fill('token').join(' ');
    const result = normalizeMineruOutputToChunks({
      title: 'Split',
      markdown: null,
      contentList: [{ type: 'text', text: repeated, page_idx: 1 }],
      chunking: {
        target_chars: 100,
        max_chars: 160,
      },
    });

    expect(result.chunks.length).toBeGreaterThan(1);
    // Implementation clamps max_chars to at least 400.
    expect(result.chunks.every((chunk) => chunk.text.length <= 400)).toBe(true);
  });
});

