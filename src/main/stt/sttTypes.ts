import type { AssistantErrorCode, SttEngine } from '../../shared/assistant';
import type { LanguageCode } from '../../shared/languages';
import type { TapMode, TapOptions } from '../../shared/offscreenContract';
import type { Direction } from '../../shared/types';

/** One passthrough stream to transcribe (spec §6.2). */
export interface SttTarget {
  streamId: string;
  direction: Direction;
  lang: LanguageCode;
}

/**
 * One piece of recognized text. `append` joins `text` to the entry's original (deltas);
 * `replace` overwrites it (OpenAI `completed` events carry the full item transcript).
 */
export interface SttSegment {
  id: string;
  direction: Direction;
  text: string;
  final: boolean;
  mode: 'append' | 'replace';
}

/** A running engine for one stream. `appendPcm` is absent on no-op instances (no key). */
export interface SttEngineInstance {
  stop(): void;
  appendPcm?(b64: string): void;
}

export interface SttEngineFactory {
  create(
    t: SttTarget,
    onSegment: (s: SttSegment) => void,
    onError: (c: AssistantErrorCode) => void,
  ): SttEngineInstance;
}

/** Engines that actually run. M6: 'openai'; M7 widens SttEngine with 'local'. */
export type ActiveSttEngine = Exclude<SttEngine, 'off'>;

/** Engine → passthrough tap mode. M7 adds `local: 'local16k'`. */
export const TAP_MODE_FOR_ENGINE: Record<ActiveSttEngine, TapMode> = { openai: 'main24k' };

/** Main-side port to the offscreen passthrough tap. Only SttService calls it. */
export interface SttTapController {
  setTap(
    streamId: string,
    mode: TapMode,
    opts?: TapOptions,
    onPcm?: (b64: string) => void,
  ): Promise<void>;
}
