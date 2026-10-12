/**
 * Minimal fetch surface the assistant services (LLM, TTS) depend on, so tests can inject
 * a hand-rolled fake instead of the global fetch.
 */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  body?: ReadableStream<Uint8Array> | null;
}

export type FetchLike = (
  url: string,
  init: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<FetchResponseLike>;

export const nodeFetch: FetchLike = (url, init) =>
  fetch(url, init) as unknown as Promise<FetchResponseLike>;
