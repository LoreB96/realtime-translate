import { describe, it, expect } from 'vitest';
import { parseSseChunk } from '@main/llm/sse';

describe('parseSseChunk', () => {
  it('extracts data lines and keeps the incomplete tail', () => {
    const r = parseSseChunk('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"');
    expect(r.events).toEqual(['{"a":1}', '{"b":2}']);
    expect(r.rest).toBe('data: {"c"');
  });

  it('handles CRLF line endings', () => {
    const r = parseSseChunk('data: x\r\n\r\ndata: y\r\n');
    expect(r.events).toEqual(['x', 'y']);
    expect(r.rest).toBe('');
  });

  it('ignores comments, other fields and blank lines', () => {
    const r = parseSseChunk(': keep-alive\nevent: message\nid: 3\n\ndata: z\n');
    expect(r.events).toEqual(['z']);
  });

  it('passes [DONE] through', () => {
    expect(parseSseChunk('data: [DONE]\n\n').events).toEqual(['[DONE]']);
  });

  it('accepts data without a space after the colon', () => {
    expect(parseSseChunk('data:abc\n').events).toEqual(['abc']);
  });

  it('returns everything as rest when there is no newline', () => {
    expect(parseSseChunk('data: partial')).toEqual({ events: [], rest: 'data: partial' });
  });

  it('reassembles a line split across chunks', () => {
    const first = parseSseChunk('data: {"x":');
    const second = parseSseChunk(first.rest + '42}\n\n');
    expect(first.events).toEqual([]);
    expect(second.events).toEqual(['{"x":42}']);
  });
});
