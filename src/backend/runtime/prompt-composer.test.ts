import { describe, expect, it } from 'vitest';
import type { Message } from '@openintern/types/agent.js';
import { PromptComposer } from './prompt-composer.js';

function composeWithHistory(history: Message[], maxHistoryMessages: number): Message[] {
  const composer = new PromptComposer();
  return composer.compose({
    history,
    maxHistoryMessages,
    memoryHits: [],
    skills: [],
  });
}

describe('PromptComposer', () => {
  it('drops orphaned tool messages after history slicing', () => {
    const history: Message[] = [
      { role: 'user', content: 'task' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc_1', name: 'read_file', parameters: { path: 'a.md' } }],
      },
      { role: 'tool', content: '{"ok":true}', toolCallId: 'tc_1' },
      { role: 'assistant', content: 'done' },
    ];

    const composed = composeWithHistory(history, 2);
    const trimmed = composed.slice(1);

    expect(trimmed.map((m) => m.role)).toEqual(['assistant']);
    expect(trimmed[0]?.content).toBe('done');
  });

  it('removes unresolved assistant tool_calls when matching tool result is absent', () => {
    const history: Message[] = [
      { role: 'user', content: 'task' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc_1', name: 'grep_files', parameters: { pattern: 'x' } }],
      },
    ];

    const composed = composeWithHistory(history, 2);
    const trimmed = composed.slice(1);

    expect(trimmed).toHaveLength(1);
    expect(trimmed[0]?.role).toBe('user');
  });

  it('keeps valid assistant/tool call-result pairs', () => {
    const history: Message[] = [
      { role: 'user', content: 'task' },
      {
        role: 'assistant',
        content: 'reading',
        toolCalls: [{ id: 'tc_1', name: 'read_file', parameters: { path: 'a.md' } }],
      },
      { role: 'tool', content: '{"path":"a.md"}', toolCallId: 'tc_1' },
    ];

    const composed = composeWithHistory(history, 3);
    const trimmed = composed.slice(1);

    expect(trimmed).toHaveLength(3);
    expect(trimmed[1]?.role).toBe('assistant');
    expect(trimmed[1]?.toolCalls?.[0]?.id).toBe('tc_1');
    expect(trimmed[2]?.role).toBe('tool');
    expect(trimmed[2]?.toolCallId).toBe('tc_1');
  });
});


