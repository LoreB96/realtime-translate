/**
 * One client for any OpenAI-compatible `/chat/completions` endpoint (spec §6.3).
 * No Electron imports: fetch, timers, clock and logger are injected.
 * Never logs messages, prompts or response content.
 */
import { isOpenAiHost, type ReasoningEffort } from '../../shared/assistant';
import type { LlmPurpose } from '../../shared/usage';
import type { FetchLike, FetchResponseLike } from '../util/fetchLike';
import type { Logger } from '../util/logger';
import { LlmError, isAbortError, makeAbortError, mapHttpError, mapThrown } from './llmErrors';
import { parseSseChunk } from './sse';

export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  reasoningEffort: ReasoningEffort;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompleteOpts {
  messages: ChatMessage[];
  maxTokens: number;
  jsonSchema?: { name: string; schema: object };
  signal?: AbortSignal;
  /** Default: 30000 for an OpenAI host, 90000 otherwise. */
  timeoutMs?: number;
  /** What the call is for; reported with its token usage (spend tracking). */
  purpose?: LlmPurpose;
}

/** Token usage of one successful call. Counts only: never message content. */
export interface LlmUsage {
  purpose: LlmPurpose;
  baseUrl: string;
  model: string;
  /** From the reply's `usage` block; absent when the server sends none. */
  promptTokens?: number;
  completionTokens?: number;
  /** Fallback for servers without `usage`: characters sent and received. */
  promptChars: number;
  completionChars: number;
}

export const OPENAI_TIMEOUT_MS = 30000;
export const OTHER_TIMEOUT_MS = 90000;
const NON_OPENAI_TEMPERATURE = 0.3;

const SCHEMA_RETRY_RE = /response_format|json_schema/i;
const REASONING_RETRY_RE = /reasoning|think/i;

export function buildChatBody(
  cfg: LlmConfig,
  o: Pick<CompleteOpts, 'messages' | 'maxTokens' | 'jsonSchema'>,
  stream: boolean,
  omit?: { schema?: boolean; reasoning?: boolean },
): Record<string, unknown> {
  const body: Record<string, unknown> = { model: cfg.model, messages: o.messages };
  if (isOpenAiHost(cfg.baseUrl)) {
    body.max_completion_tokens = o.maxTokens;
  } else {
    body.max_tokens = o.maxTokens;
    body.temperature = NON_OPENAI_TEMPERATURE;
  }
  if (cfg.reasoningEffort !== '' && !omit?.reasoning) {
    body.reasoning_effort = cfg.reasoningEffort;
  }
  if (o.jsonSchema && !omit?.schema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: o.jsonSchema.name, strict: true, schema: o.jsonSchema.schema },
    };
  }
  if (stream) body.stream = true;
  return body;
}

/**
 * Removes `<think>…</think>` blocks. Also drops a dangling prefix ending in `</think>`
 * (opening tag omitted by the server template) and an unterminated trailing `<think>…`.
 */
export function stripThink(s: string): string {
  let out = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const close = out.search(/<\/think>/i);
  if (close !== -1) out = out.slice(close + '</think>'.length);
  const open = out.search(/<think>/i);
  if (open !== -1) out = out.slice(0, open);
  return out;
}

const OPENAI_CHAT_RE = /^(gpt-|o\d|chatgpt)/;
const OPENAI_NON_CHAT_RE = /(audio|realtime|transcribe|tts|image|search|embedding)/;

export function filterOpenAiChatModels(ids: string[]): string[] {
  return ids.filter((id) => OPENAI_CHAT_RE.test(id) && !OPENAI_NON_CHAT_RE.test(id));
}

export interface LlmClientDeps {
  fetch: FetchLike;
  config: () => LlmConfig;
  logger?: Logger;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  now?: () => number;
  /** Called after each successful complete() with its token usage. */
  onUsage?: (u: LlmUsage) => void;
}

interface CallCtx {
  signal: AbortSignal;
  /** Last HTTP status seen, for failure logging. */
  status?: number;
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function firstChoice(json: unknown): Record<string, unknown> | undefined {
  if (!isObject(json) || !Array.isArray(json.choices)) return undefined;
  const c: unknown = json.choices[0];
  return isObject(c) ? c : undefined;
}

export class LlmClient {
  constructor(private readonly deps: LlmClientDeps) {}

  /** Non-streaming chat completion; returns the think-stripped, trimmed content. */
  async complete(o: CompleteOpts): Promise<string> {
    const cfg = this.deps.config();
    return this.run(o.signal, this.timeoutFor(cfg, o.timeoutMs), async (ctx) => {
      const started = this.now();
      const res = await this.postChat(cfg, o, false, ctx);
      let json: unknown;
      try {
        json = await res.json();
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        throw new LlmError('llm-bad-response', res.status);
      }
      const choice = firstChoice(json);
      const finish = typeof choice?.finish_reason === 'string' ? choice.finish_reason : '';
      if (finish === 'length') throw new LlmError('llm-truncated', res.status);
      const message = choice?.message;
      const content = isObject(message) ? message.content : undefined;
      if (typeof content !== 'string') throw new LlmError('llm-bad-response', res.status);
      const text = stripThink(content).trim();
      if (text === '') throw new LlmError('llm-bad-response', res.status);
      this.reportUsage(cfg, o, json, content.length);
      this.deps.logger?.info('llm_request_done', {
        status: res.status,
        ms: this.now() - started,
        model: cfg.model,
        finish,
      });
      return text;
    });
  }

  /** Streaming chat completion (SSE). `onDelta` receives raw content deltas. */
  async stream(o: CompleteOpts, onDelta: (t: string) => void): Promise<string> {
    const cfg = this.deps.config();
    return this.run(o.signal, this.timeoutFor(cfg, o.timeoutMs), async (ctx) => {
      const started = this.now();
      const res = await this.postChat(cfg, o, true, ctx);
      if (!res.body) throw new LlmError('llm-bad-response', res.status);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let full = '';
      let finish = '';
      let done = false;

      const handle = (ev: string): void => {
        if (ev.trim() === '[DONE]') {
          done = true;
          return;
        }
        let json: unknown;
        try {
          json = JSON.parse(ev);
        } catch {
          return; // tolerate keep-alive noise
        }
        const choice = firstChoice(json);
        if (!choice) return;
        const delta = choice.delta;
        const piece = isObject(delta) ? delta.content : undefined;
        if (typeof piece === 'string' && piece !== '') {
          full += piece;
          onDelta(piece);
        }
        if (typeof choice.finish_reason === 'string') {
          finish = choice.finish_reason;
          if (finish === 'length') throw new LlmError('llm-truncated', res.status);
        }
      };

      try {
        while (!done) {
          const r = await reader.read();
          if (r.done) {
            buffer += decoder.decode();
            break;
          }
          buffer += decoder.decode(r.value, { stream: true });
          const parsed = parseSseChunk(buffer);
          buffer = parsed.rest;
          for (const ev of parsed.events) {
            handle(ev);
            if (done) break;
          }
        }
        if (!done && buffer !== '') {
          for (const ev of parseSseChunk(buffer + '\n').events) {
            handle(ev);
            if (done) break;
          }
        }
      } finally {
        reader.cancel().catch(() => undefined);
      }

      const text = stripThink(full).trim();
      if (text === '') throw new LlmError('llm-bad-response', res.status);
      this.deps.logger?.info('llm_request_done', {
        status: res.status,
        ms: this.now() - started,
        model: cfg.model,
        finish,
      });
      return text;
    });
  }

  /** `GET {base}/models` → sorted ids; chat-capable ids only on an OpenAI host. */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const cfg = this.deps.config();
    return this.run(signal, this.timeoutFor(cfg, undefined), async (ctx) => {
      this.requireKey(cfg);
      const res = await this.deps.fetch(`${trimBase(cfg.baseUrl)}/models`, {
        method: 'GET',
        headers: this.headers(cfg),
        signal: ctx.signal,
      });
      ctx.status = res.status;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new LlmError(mapHttpError(res.status, text), res.status);
      }
      let json: unknown;
      try {
        json = await res.json();
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        throw new LlmError('llm-bad-response', res.status);
      }
      if (!isObject(json) || !Array.isArray(json.data)) {
        throw new LlmError('llm-bad-response', res.status);
      }
      const ids: string[] = [];
      for (const m of json.data as unknown[]) {
        if (isObject(m) && typeof m.id === 'string' && m.id !== '') ids.push(m.id);
      }
      ids.sort();
      return isOpenAiHost(cfg.baseUrl) ? filterOpenAiChatModels(ids) : ids;
    });
  }

  // -------------------------------------------------------------------------

  private reportUsage(cfg: LlmConfig, o: CompleteOpts, json: unknown, completionChars: number): void {
    if (!this.deps.onUsage) return;
    const usage = isObject(json) && isObject(json.usage) ? json.usage : undefined;
    const pt = usage?.prompt_tokens;
    const ct = usage?.completion_tokens;
    const counted = typeof pt === 'number' && typeof ct === 'number' && pt >= 0 && ct >= 0;
    this.deps.onUsage({
      purpose: o.purpose ?? 'test',
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      ...(counted ? { promptTokens: pt, completionTokens: ct } : {}),
      promptChars: o.messages.reduce((n, m) => n + m.content.length, 0),
      completionChars,
    });
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private timeoutFor(cfg: LlmConfig, explicit: number | undefined): number {
    if (explicit !== undefined) return explicit;
    return isOpenAiHost(cfg.baseUrl) ? OPENAI_TIMEOUT_MS : OTHER_TIMEOUT_MS;
  }

  /**
   * api.openai.com always needs a key: never send conversation text there without one, and
   * report the real reason (no key) instead of the server's 401 → llm-auth.
   */
  private requireKey(cfg: LlmConfig): void {
    if (isOpenAiHost(cfg.baseUrl) && !cfg.apiKey) throw new LlmError('no-openai-key');
  }

  private headers(cfg: LlmConfig): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) h.Authorization = `Bearer ${cfg.apiKey}`;
    return h;
  }

  /** POSTs the chat body, applying the schema / reasoning retries (max 3 requests). */
  private async postChat(
    cfg: LlmConfig,
    o: CompleteOpts,
    stream: boolean,
    ctx: CallCtx,
  ): Promise<FetchResponseLike> {
    if (cfg.model.trim() === '') throw new LlmError('llm-model-missing');
    this.requireKey(cfg);
    const url = `${trimBase(cfg.baseUrl)}/chat/completions`;
    const omit = { schema: false, reasoning: false };
    for (;;) {
      const body = buildChatBody(cfg, o, stream, omit);
      const res = await this.deps.fetch(url, {
        method: 'POST',
        headers: this.headers(cfg),
        body: JSON.stringify(body),
        signal: ctx.signal,
      });
      ctx.status = res.status;
      if (res.ok) return res;
      const text = await res.text().catch(() => '');
      if (res.status === 400) {
        if (!omit.schema && 'response_format' in body && SCHEMA_RETRY_RE.test(text)) {
          omit.schema = true;
          this.deps.logger?.info('llm_retry', { reason: 'schema' });
          continue;
        }
        if (!omit.reasoning && 'reasoning_effort' in body && REASONING_RETRY_RE.test(text)) {
          omit.reasoning = true;
          this.deps.logger?.info('llm_retry', { reason: 'reasoning' });
          continue;
        }
      }
      throw new LlmError(mapHttpError(res.status, text), res.status);
    }
  }

  /**
   * Runs one logical call with an internal AbortController: timeout → `llm-timeout`,
   * caller abort → rethrown AbortError, anything else → `LlmError` with a mapped code.
   */
  private async run<T>(
    callerSignal: AbortSignal | undefined,
    timeoutMs: number,
    fn: (ctx: CallCtx) => Promise<T>,
  ): Promise<T> {
    if (callerSignal?.aborted) throw makeAbortError();
    const controller = new AbortController();
    let timedOut = false;
    let callerAborted = false;
    const onCallerAbort = (): void => {
      callerAborted = true;
      controller.abort();
    };
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    const setTimer = this.deps.setTimer ?? setTimeout;
    const clearTimer = this.deps.clearTimer ?? clearTimeout;
    const timer = setTimer(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const ctx: CallCtx = { signal: controller.signal };
    try {
      return await fn(ctx);
    } catch (err) {
      if (callerAborted) throw makeAbortError();
      let error: LlmError;
      if (timedOut) error = new LlmError('llm-timeout', ctx.status);
      else if (err instanceof LlmError) error = err;
      else if (isAbortError(err)) error = new LlmError('unknown', ctx.status);
      else error = new LlmError(mapThrown(err, false), ctx.status);
      this.deps.logger?.warn('llm_request_failed', {
        code: error.code,
        ...(error.status !== undefined ? { status: error.status } : {}),
      });
      throw error;
    } finally {
      clearTimer(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  }
}
