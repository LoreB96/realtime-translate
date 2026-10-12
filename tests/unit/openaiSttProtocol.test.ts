import { describe, it, expect } from 'vitest';
import { OPENAI_STT_URL, buildSttSessionUpdate, parseSttEvent } from '@main/stt/openaiSttProtocol';

describe('openaiSttProtocol', () => {
  it('uses the realtime transcription endpoint', () => {
    expect(OPENAI_STT_URL).toBe('wss://api.openai.com/v1/realtime?intent=transcription');
  });

  it('builds the mini-transcribe update with a single language and near-field NR for A', () => {
    expect(buildSttSessionUpdate('gpt-4o-mini-transcribe', 'it', true)).toEqual({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: 'gpt-4o-mini-transcribe', language: 'it' },
            noise_reduction: { type: 'near_field' },
            turn_detection: null,
          },
        },
      },
    });
  });

  it('sends noise_reduction null for direction B', () => {
    const u = buildSttSessionUpdate('gpt-4o-transcribe', 'en', false) as {
      session: { audio: { input: { noise_reduction: unknown; transcription: unknown } } };
    };
    expect(u.session.audio.input.noise_reduction).toBeNull();
    expect(u.session.audio.input.transcription).toEqual({
      model: 'gpt-4o-transcribe',
      language: 'en',
    });
  });

  it('gives gpt-live-transcribe a languages array instead of language', () => {
    const u = buildSttSessionUpdate('gpt-live-transcribe', 'pt', true) as {
      session: { audio: { input: { transcription: Record<string, unknown> } } };
    };
    expect(u.session.audio.input.transcription).toEqual({
      model: 'gpt-live-transcribe',
      languages: ['pt'],
    });
    expect(u.session.audio.input.transcription).not.toHaveProperty('language');
  });

  it('parses delta, completed and failed events', () => {
    expect(
      parseSttEvent(
        JSON.stringify({
          type: 'conversation.item.input_audio_transcription.delta',
          item_id: 'item_1',
          delta: 'Hel',
        }),
      ),
    ).toEqual({ kind: 'delta', itemId: 'item_1', text: 'Hel' });
    expect(
      parseSttEvent(
        JSON.stringify({
          type: 'conversation.item.input_audio_transcription.completed',
          item_id: 'item_1',
          transcript: 'Hello there.',
        }),
      ),
    ).toEqual({ kind: 'completed', itemId: 'item_1', text: 'Hello there.' });
    expect(
      parseSttEvent(
        JSON.stringify({
          type: 'conversation.item.input_audio_transcription.failed',
          item_id: 'item_2',
          error: { message: 'x' },
        }),
      ),
    ).toEqual({ kind: 'failed', itemId: 'item_2' });
  });

  it('parses error events and classifies fatal ones', () => {
    expect(
      parseSttEvent(
        JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', code: 'unknown_parameter', param: 'session.x' },
        }),
      ),
    ).toEqual({
      kind: 'error',
      code: 'unknown_parameter',
      type: 'invalid_request_error',
      param: 'session.x',
      fatal: true,
    });
    expect(
      parseSttEvent(
        JSON.stringify({ type: 'error', error: { type: 'x', code: 'invalid_api_key' } }),
      ),
    ).toMatchObject({ kind: 'error', fatal: true });
    const transient = parseSttEvent(
      JSON.stringify({ type: 'error', error: { type: 'server_error', code: 'oops' } }),
    );
    expect(transient).toEqual({ kind: 'error', code: 'oops', type: 'server_error', fatal: false });
    for (const code of ['session_expired', 'input_audio_buffer_commit_empty']) {
      expect(
        parseSttEvent(
          JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', code } }),
        ),
      ).toMatchObject({ kind: 'error', code, fatal: false });
    }
    expect(parseSttEvent(JSON.stringify({ type: 'error' }))).toEqual({
      kind: 'error',
      code: 'unknown',
      type: 'unknown',
      fatal: false,
    });
  });

  it('returns undefined for malformed or irrelevant frames', () => {
    expect(parseSttEvent('not json')).toBeUndefined();
    expect(parseSttEvent('null')).toBeUndefined();
    expect(parseSttEvent('[]')).toBeUndefined();
    expect(parseSttEvent(JSON.stringify({ type: 'session.created' }))).toBeUndefined();
    expect(
      parseSttEvent(
        JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', delta: 'x' }),
      ),
    ).toBeUndefined();
    expect(
      parseSttEvent(
        JSON.stringify({
          type: 'conversation.item.input_audio_transcription.delta',
          item_id: 'i',
          delta: 5,
        }),
      ),
    ).toBeUndefined();
    expect(
      parseSttEvent(
        JSON.stringify({
          type: 'conversation.item.input_audio_transcription.completed',
          item_id: 'i',
        }),
      ),
    ).toBeUndefined();
  });
});
