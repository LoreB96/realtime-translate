import { describe, it, expect, vi } from 'vitest';
import {
  LlmClient,
  buildChatBody,
  filterOpenAiChatModels,
  stripThink,
  type LlmConfig,
} from '@main/llm/llmClient';
import { LlmError, isAbortError, mapHttpError, mapThrown } from '@main/llm/llmErrors';
import type { FetchLike, FetchResponseLike } from '@main/util/fetchLike';
import type { Logger } from '@main/util/logger';

const OPENAI: LlmConfig = {
  baseUrl: 'https://api.openai.com/v1/',
  model: 'gpt-5-mini',
  apiKey: 'sk-test',
  reasoningEffort: 'minimal',
};
const OLLAMA: LlmConfig = {
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen3:8b',
  reasoningEffort: 'none',
};
const MSGS = [{ role: 'user' as const, content: 'hi' }];
const SCHEMA = { name: 'reply_suggestions', schema: { type: 'object' } };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
  signal: AbortSignal | undefined;
}

type Responder = (call: Call) => Promise<FetchResponseLike> | FetchResponseLike;

function jsonRes(status: number, json: unknown): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
  };
}

function textRes(status: number, text: string): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text) as unknown,
    text: async () => text,
  };
}

function chat(content: unknown, finish = 'stop'): FetchResponseLike {
  return jsonRes(200, { choices: [{ message: { content }, finish_reason: finish }] });
}

function streamRes(chunks: string[]): FetchResponseLike {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return { ok: true, status: 200, json: async () => ({}), text: async () => '', body };
}

/** Never resolves until the request signal aborts, then rejects with an AbortError. */
function hanging(call: Call): Promise<FetchResponseLike> {
  return new Promise((_resolve, reject) => {
    call.signal?.addEventListener('abort', () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    });
  });
}

function setup(cfg: LlmConfig, responders: Responder[]) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: Call = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
      signal: init.signal,
    };
    calls.push(call);
    const r = responders.shift();
    if (!r) throw new Error('unexpected fetch');
    return r(call);
  };
  const logs: Array<{ level: string; event: string; data?: Record<string, unknown> }> = [];
  const mk =
    (level: string) =>
    (event: string, data?: Record<string, unknown>): void => {
      logs.push({ level, event, ...(data ? { data } : {}) });
    };
  const logger: Logger = {
    debug: mk('debug'),
    info: mk('info'),
    warn: mk('warn'),
    error: mk('error'),
  };
  const client = new LlmClient({ fetch, config: () => cfg, logger, now: () => 1000 });
  return { client, calls, logs };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof LlmError) return err.code;
    if (isAbortError(err)) return 'abort';
    throw err;
  }
  return 'resolved';
}

describe('buildChatBody', () => {
  it('OpenAI host: max_completion_tokens, no temperature, reasoning_effort', () => {
    const b = buildChatBody(OPENAI, { messages: MSGS, maxTokens: 100 }, false);
    expect(b).toEqual({
      model: 'gpt-5-mini',
      messages: MSGS,
      max_completion_tokens: 100,
      reasoning_effort: 'minimal',
    });
  });

  it('other hosts: max_tokens + temperature', () => {
    const b = buildChatBody(OLLAMA, { messages: MSGS, maxTokens: 50 }, true);
    expect(b).toEqual({
      model: 'qwen3:8b',
      messages: MSGS,
      max_tokens: 50,
      temperature: 0.3,
      reasoning_effort: 'none',
      stream: true,
    });
  });

  it('omits reasoning_effort when empty or omitted', () => {
    const cfg = { ...OLLAMA, reasoningEffort: '' as const };
    expect(buildChatBody(cfg, { messages: MSGS, maxTokens: 1 }, false)).not.toHaveProperty(
      'reasoning_effort',
    );
    expect(
      buildChatBody(OLLAMA, { messages: MSGS, maxTokens: 1 }, false, { reasoning: true }),
    ).not.toHaveProperty('reasoning_effort');
  });

  it('adds a strict json_schema response_format unless omitted', () => {
    const o = { messages: MSGS, maxTokens: 1, jsonSchema: SCHEMA };
    expect(buildChatBody(OPENAI, o, false).response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'reply_suggestions', strict: true, schema: { type: 'object' } },
    });
    expect(buildChatBody(OPENAI, o, false, { schema: true })).not.toHaveProperty('response_format');
  });

  it('treats http://api.openai.com as a non-OpenAI host', () => {
    const b = buildChatBody(
      { ...OPENAI, baseUrl: 'http://api.openai.com/v1' },
      { messages: MSGS, maxTokens: 1 },
      false,
    );
    expect(b).toHaveProperty('max_tokens');
  });
});

describe('stripThink / filterOpenAiChatModels / error mapping', () => {
  it('strips think blocks', () => {
    expect(stripThink('<think>hmm\nmore</think>\nAnswer')).toBe('\nAnswer');
    expect(stripThink('a<think>x</think>b<THINK>y</THINK>c')).toBe('abc');
    expect(stripThink('reasoning...</think>Answer')).toBe('Answer');
    expect(stripThink('Answer<think>unterminated')).toBe('Answer');
    expect(stripThink('plain')).toBe('plain');
  });

  it('filters OpenAI chat models', () => {
    expect(
      filterOpenAiChatModels([
        'gpt-5-mini',
        'o3',
        'chatgpt-4o-latest',
        'gpt-4o-realtime-preview',
        'gpt-4o-mini-transcribe',
        'gpt-4o-mini-tts',
        'gpt-image-1',
        'gpt-4o-search-preview',
        'gpt-audio',
        'text-embedding-3-small',
        'dall-e-3',
        'whisper-1',
      ]),
    ).toEqual(['gpt-5-mini', 'o3', 'chatgpt-4o-latest']);
  });

  it('maps HTTP errors', () => {
    expect(mapHttpError(401, '')).toBe('llm-auth');
    expect(mapHttpError(403, '')).toBe('llm-auth');
    expect(mapHttpError(404, '')).toBe('llm-model-missing');
    expect(mapHttpError(400, '{"error":"model \\"x\\" not found, try pulling it"}')).toBe(
      'llm-model-missing',
    );
    expect(mapHttpError(400, 'The model foo does not exist')).toBe('llm-model-missing');
    expect(mapHttpError(429, '')).toBe('rate-limited');
    expect(mapHttpError(500, 'boom')).toBe('unknown');
  });

  it('maps thrown errors', () => {
    expect(mapThrown(new TypeError('fetch failed'), false)).toBe('llm-unreachable');
    expect(mapThrown(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), false)).toBe(
      'llm-unreachable',
    );
    expect(mapThrown(new Error('x', { cause: { code: 'ENOTFOUND' } }), false)).toBe(
      'llm-unreachable',
    );
    expect(mapThrown(Object.assign(new Error('x'), { code: 'ECONNRESET' }), false)).toBe(
      'llm-unreachable',
    );
    expect(mapThrown(new Error('x'), true)).toBe('llm-timeout');
    expect(mapThrown(new LlmError('llm-auth'), false)).toBe('llm-auth');
    expect(mapThrown(new Error('x'), false)).toBe('unknown');
  });
});

describe('LlmClient.complete', () => {
  it('posts to {base}/chat/completions with the bearer header and returns trimmed content', async () => {
    const { client, calls, logs } = setup(OPENAI, [() => chat('  Hello  ')]);
    await expect(client.complete({ messages: MSGS, maxTokens: 10 })).resolves.toBe('Hello');
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-test',
    });
    expect(calls[0]?.body?.max_completion_tokens).toBe(10);
    expect(calls[0]?.body).not.toHaveProperty('temperature');
    expect(logs).toContainEqual({
      level: 'info',
      event: 'llm_request_done',
      data: { status: 200, ms: 0, model: 'gpt-5-mini', finish: 'stop' },
    });
    expect(JSON.stringify(logs)).not.toContain('Hello');
  });

  it('sends no Authorization header without a key', async () => {
    const { client, calls } = setup(OLLAMA, [() => chat('ok')]);
    await client.complete({ messages: MSGS, maxTokens: 10 });
    expect(calls[0]?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(calls[0]?.body?.max_tokens).toBe(10);
    expect(calls[0]?.body?.temperature).toBe(0.3);
  });

  it('OpenAI host without a key → no-openai-key and no request is sent', async () => {
    const noKey: LlmConfig = { ...OPENAI };
    delete noKey.apiKey;
    const { client, calls } = setup(noKey, []);
    expect(await codeOf(client.complete({ messages: MSGS, maxTokens: 10 }))).toBe(
      'no-openai-key',
    );
    expect(await codeOf(client.listModels())).toBe('no-openai-key');
    expect(calls).toHaveLength(0);
  });

  it('throws llm-model-missing before fetch on an empty model', async () => {
    const { client, calls } = setup({ ...OLLAMA, model: '  ' }, []);
    expect(await codeOf(client.complete({ messages: MSGS, maxTokens: 1 }))).toBe(
      'llm-model-missing',
    );
    expect(calls).toHaveLength(0);
  });

  it('retries once without the schema', async () => {
    const { client, calls, logs } = setup(OLLAMA, [
      () => textRes(400, 'response_format json_schema not supported'),
      () => chat('{"suggestions":[]}'),
    ]);
    await client.complete({ messages: MSGS, maxTokens: 1, jsonSchema: SCHEMA });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toHaveProperty('response_format');
    expect(calls[1]?.body).not.toHaveProperty('response_format');
    expect(calls[1]?.body).toHaveProperty('reasoning_effort');
    expect(logs.some((l) => l.event === 'llm_retry' && l.data?.reason === 'schema')).toBe(true);
  });

  it('does not retry the schema when none was sent', async () => {
    const { client, calls } = setup(OLLAMA, [() => textRes(400, 'json_schema something')]);
    expect(await codeOf(client.complete({ messages: MSGS, maxTokens: 1 }))).toBe('unknown');
    expect(calls).toHaveLength(1);
  });

  it('retries once without reasoning_effort', async () => {
    const { client, calls } = setup(OLLAMA, [
      () => textRes(400, 'model does not support thinking'),
      () => chat('ok'),
    ]);
    await client.complete({ messages: MSGS, maxTokens: 1 });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toHaveProperty('reasoning_effort');
    expect(calls[1]?.body).not.toHaveProperty('reasoning_effort');
  });

  it('can do both retries in one call (max 3 requests)', async () => {
    const { client, calls } = setup(OLLAMA, [
      () => textRes(400, 'unsupported response_format'),
      () => textRes(400, 'invalid reasoning_effort'),
      () => textRes(400, 'invalid reasoning_effort again'),
    ]);
    expect(
      await codeOf(client.complete({ messages: MSGS, maxTokens: 1, jsonSchema: SCHEMA })),
    ).toBe('unknown');
    expect(calls).toHaveLength(3);
    expect(calls[2]?.body).not.toHaveProperty('response_format');
    expect(calls[2]?.body).not.toHaveProperty('reasoning_effort');
  });

  it('maps 401 / 404 / 429 and logs code + status', async () => {
    for (const [status, code] of [
      [401, 'llm-auth'],
      [404, 'llm-model-missing'],
      [429, 'rate-limited'],
    ] as const) {
      const { client, logs } = setup(OPENAI, [() => textRes(status, 'err')]);
      const p = client.complete({ messages: MSGS, maxTokens: 1 });
      await expect(p).rejects.toMatchObject({ code, status });
      expect(logs).toContainEqual({
        level: 'warn',
        event: 'llm_request_failed',
        data: { code, status },
      });
    }
  });

  it('maps a fetch TypeError to llm-unreachable', async () => {
    const { client } = setup(OLLAMA, [
      () => {
        throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
      },
    ]);
    expect(await codeOf(client.complete({ messages: MSGS, maxTokens: 1 }))).toBe('llm-unreachable');
  });

  it('times out after 30 s on an OpenAI host', async () => {
    vi.useFakeTimers();
    try {
      const { client } = setup(OPENAI, [hanging]);
      const p = codeOf(client.complete({ messages: MSGS, maxTokens: 1 }));
      await vi.advanceTimersByTimeAsync(29999);
      let settled = false;
      void p.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await p).toBe('llm-timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out after 90 s on other hosts', async () => {
    vi.useFakeTimers();
    try {
      const { client } = setup(OLLAMA, [hanging]);
      let result: string | undefined;
      void codeOf(client.complete({ messages: MSGS, maxTokens: 1 })).then((c) => (result = c));
      await vi.advanceTimersByTimeAsync(30000);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(60000);
      expect(result).toBe('llm-timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('honours an explicit timeoutMs', async () => {
    vi.useFakeTimers();
    try {
      const { client } = setup(OLLAMA, [hanging]);
      let result: string | undefined;
      void codeOf(client.complete({ messages: MSGS, maxTokens: 1, timeoutMs: 120000 })).then(
        (c) => (result = c),
      );
      await vi.advanceTimersByTimeAsync(90000);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(30000);
      expect(result).toBe('llm-timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rethrows an AbortError when the caller aborts', async () => {
    const { client, logs } = setup(OPENAI, [hanging]);
    const ctrl = new AbortController();
    const p = codeOf(client.complete({ messages: MSGS, maxTokens: 1, signal: ctrl.signal }));
    ctrl.abort();
    expect(await p).toBe('abort');
    expect(logs.some((l) => l.event === 'llm_request_failed')).toBe(false);
  });

  it('rejects immediately with AbortError for an already-aborted signal', async () => {
    const { client, calls } = setup(OPENAI, []);
    const ctrl = new AbortController();
    ctrl.abort();
    expect(
      await codeOf(client.complete({ messages: MSGS, maxTokens: 1, signal: ctrl.signal })),
    ).toBe('abort');
    expect(calls).toHaveLength(0);
  });

  it("finish_reason 'length' → llm-truncated", async () => {
    const { client } = setup(OPENAI, [() => chat('partial', 'length')]);
    expect(await codeOf(client.complete({ messages: MSGS, maxTokens: 1 }))).toBe('llm-truncated');
  });

  it('empty content after think-strip → llm-bad-response', async () => {
    const { client } = setup(OLLAMA, [() => chat('<think>only thoughts</think>  ')]);
    expect(await codeOf(client.complete({ messages: MSGS, maxTokens: 1 }))).toBe(
      'llm-bad-response',
    );
  });

  it('non-string content or malformed JSON → llm-bad-response', async () => {
    const a = setup(OLLAMA, [() => chat(null)]);
    expect(await codeOf(a.client.complete({ messages: MSGS, maxTokens: 1 }))).toBe(
      'llm-bad-response',
    );
    const b = setup(OLLAMA, [() => textRes(200, 'not json')]);
    expect(await codeOf(b.client.complete({ messages: MSGS, maxTokens: 1 }))).toBe(
      'llm-bad-response',
    );
  });

  it('strips think blocks from the answer', async () => {
    const { client } = setup(OLLAMA, [() => chat('<think>let me see</think>\n\nBonjour')]);
    await expect(client.complete({ messages: MSGS, maxTokens: 1 })).resolves.toBe('Bonjour');
  });
});

describe('LlmClient.stream', () => {
  it('parses SSE split mid-line and mid-character', async () => {
    const ev = (s: string) =>
      `data: ${JSON.stringify({ choices: [{ delta: { content: s } }] })}\n\n`;
    const all = ev('<think>x</think>Ol') + ev('á, ') + ev('mundo') + 'data: [DONE]\n\n';
    const bytes = new TextEncoder().encode(all);
    // Split into 7-byte chunks (splits lines and the multi-byte 'á').
    const chunks: string[] = [];
    const parts: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 7) parts.push(bytes.slice(i, i + 7));
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(p);
        c.close();
      },
    });
    const res: FetchResponseLike = {
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '',
      body,
    };
    const { client, calls } = setup(OLLAMA, [() => res]);
    const text = await client.stream({ messages: MSGS, maxTokens: 1 }, (d) => chunks.push(d));
    expect(text).toBe('Olá, mundo');
    expect(chunks.join('')).toBe('<think>x</think>Olá, mundo');
    expect(calls[0]?.body?.stream).toBe(true);
  });

  it("finish_reason 'length' in a chunk → llm-truncated", async () => {
    const { client } = setup(OLLAMA, [
      () =>
        streamRes([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'a' } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`,
        ]),
    ]);
    expect(await codeOf(client.stream({ messages: MSGS, maxTokens: 1 }, () => undefined))).toBe(
      'llm-truncated',
    );
  });

  it('empty stream → llm-bad-response; null body → llm-bad-response', async () => {
    const a = setup(OLLAMA, [() => streamRes(['data: [DONE]\n\n'])]);
    expect(await codeOf(a.client.stream({ messages: MSGS, maxTokens: 1 }, () => undefined))).toBe(
      'llm-bad-response',
    );
    const b = setup(OLLAMA, [() => ({ ...jsonRes(200, {}), body: null })]);
    expect(await codeOf(b.client.stream({ messages: MSGS, maxTokens: 1 }, () => undefined))).toBe(
      'llm-bad-response',
    );
  });

  it('handles a final event without trailing newline', async () => {
    const { client } = setup(OLLAMA, [
      () => streamRes([`data: ${JSON.stringify({ choices: [{ delta: { content: 'end' } }] })}`]),
    ]);
    await expect(client.stream({ messages: MSGS, maxTokens: 1 }, () => undefined)).resolves.toBe(
      'end',
    );
  });
});

describe('LlmClient.listModels', () => {
  it('sorts ids and filters on an OpenAI host', async () => {
    const { client, calls } = setup(OPENAI, [
      () =>
        jsonRes(200, {
          data: [{ id: 'gpt-5-mini' }, { id: 'whisper-1' }, { id: 'gpt-4.1' }, { id: 'tts-1' }],
        }),
    ]);
    await expect(client.listModels()).resolves.toEqual(['gpt-4.1', 'gpt-5-mini']);
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/models');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers.Authorization).toBe('Bearer sk-test');
  });

  it('does not filter on other hosts', async () => {
    const { client } = setup(OLLAMA, [
      () => jsonRes(200, { data: [{ id: 'qwen3:8b' }, { id: 'llama3.2:3b' }, { id: 7 }] }),
    ]);
    await expect(client.listModels()).resolves.toEqual(['llama3.2:3b', 'qwen3:8b']);
  });

  it('works with an empty model and maps errors', async () => {
    const ok = setup({ ...OLLAMA, model: '' }, [() => jsonRes(200, { data: [] })]);
    await expect(ok.client.listModels()).resolves.toEqual([]);
    const bad = setup(OPENAI, [() => textRes(401, 'nope')]);
    expect(await codeOf(bad.client.listModels())).toBe('llm-auth');
    const shape = setup(OPENAI, [() => jsonRes(200, { nope: true })]);
    expect(await codeOf(shape.client.listModels())).toBe('llm-bad-response');
  });
});

describe('LlmClient usage reporting', () => {
  const run = async (
    cfg: LlmConfig,
    res: FetchResponseLike,
    purpose?: 'suggest' | 'speak',
  ): Promise<unknown[]> => {
    const seen: unknown[] = [];
    const fetch: FetchLike = async () => res;
    const client = new LlmClient({ fetch, config: () => cfg, onUsage: (u) => seen.push(u) });
    await client.complete({ messages: MSGS, maxTokens: 10, ...(purpose ? { purpose } : {}) });
    return seen;
  };

  it('reports the token counts of the reply with the purpose, model and server', async () => {
    const res = jsonRes(200, {
      choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 30 },
    });
    expect(await run(OPENAI, res, 'suggest')).toEqual([
      {
        purpose: 'suggest',
        baseUrl: OPENAI.baseUrl,
        model: 'gpt-5-mini',
        promptTokens: 120,
        completionTokens: 30,
        promptChars: 2,
        completionChars: 5,
      },
    ]);
  });

  it('falls back to character counts without a usage block; untagged calls are "test"', async () => {
    const [u] = await run(OLLAMA, chat('  Hi there '));
    expect(u).toEqual({
      purpose: 'test',
      baseUrl: OLLAMA.baseUrl,
      model: 'qwen3:8b',
      promptChars: 2,
      completionChars: 11, // raw content, before trimming
    });
  });

  it('reports nothing for a failed call', async () => {
    const seen: unknown[] = [];
    const client = new LlmClient({
      fetch: async () => chat('', 'stop'),
      config: () => OPENAI,
      onUsage: (u) => seen.push(u),
    });
    await expect(client.complete({ messages: MSGS, maxTokens: 10 })).rejects.toThrow();
    expect(seen).toEqual([]);
  });
});
