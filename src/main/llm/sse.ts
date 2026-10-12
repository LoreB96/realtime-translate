/**
 * Minimal server-sent-events chunk parser for OpenAI-compatible streaming (spec §6.3).
 * Pure. Each `data:` line becomes one event; comments (`:`), other fields and blank lines
 * are ignored; `[DONE]` is passed through; an incomplete trailing line is returned in `rest`
 * so the caller prepends it to the next chunk.
 */
export function parseSseChunk(buffer: string): { events: string[]; rest: string } {
  const events: string[] = [];
  const lastNl = buffer.lastIndexOf('\n');
  if (lastNl === -1) return { events, rest: buffer };
  const complete = buffer.slice(0, lastNl);
  const rest = buffer.slice(lastNl + 1);
  for (const rawLine of complete.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith('data:')) continue;
    let value = line.slice(5);
    if (value.startsWith(' ')) value = value.slice(1);
    events.push(value);
  }
  return { events, rest };
}
