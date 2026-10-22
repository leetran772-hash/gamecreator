// ElevenLabs: sound effects, music and character voices. Each endpoint returns
// audio bytes (MP3 by default); the audio pipeline then normalizes them to OGG.
import { defaultServices, ServiceError, type Fetch, type Services } from "./services";

export interface ElevenLabsOptions {
  apiKey: string;
  services?: Services;
  fetch?: Fetch;
}

export interface SfxRequest {
  text: string;
  /** 0.5-30 s; omitted lets ElevenLabs pick a length. */
  durationSeconds?: number;
  /** 0-1: how literally the prompt is followed. */
  promptInfluence?: number;
}

async function postForAudio(o: ElevenLabsOptions, path: string, body: object): Promise<Uint8Array> {
  const cfg = (o.services ?? defaultServices).elevenlabs;
  const res = await (o.fetch ?? fetch)(`${cfg.baseUrl}${path}`, {
    method: "POST",
    headers: { "xi-api-key": o.apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ServiceError("ElevenLabs", res.status, await res.text());
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.length) throw new Error(`ElevenLabs returned no audio for ${path}`);
  return bytes;
}

/** Request body for POST /v1/sound-generation. */
export function sfxBody(r: SfxRequest, services: Services = defaultServices) {
  const cfg = services.elevenlabs;
  if (r.durationSeconds !== undefined && (r.durationSeconds < cfg.sfxMinSeconds || r.durationSeconds > cfg.sfxMaxSeconds))
    throw new Error(`SFX duration must be ${cfg.sfxMinSeconds}-${cfg.sfxMaxSeconds} seconds (got ${r.durationSeconds})`);
  return {
    text: r.text,
    model_id: cfg.sfxModel,
    ...(r.durationSeconds !== undefined ? { duration_seconds: r.durationSeconds } : {}),
    prompt_influence: r.promptInfluence ?? cfg.sfxPromptInfluence,
  };
}

/** Request body for POST /v1/music. */
export function musicBody(prompt: string, lengthMs: number, services: Services = defaultServices) {
  const cfg = services.elevenlabs;
  if (lengthMs < cfg.musicMinMs || lengthMs > cfg.musicMaxMs)
    throw new Error(`Music length must be ${cfg.musicMinMs / 1000}-${cfg.musicMaxMs / 1000} seconds (got ${lengthMs / 1000})`);
  return { prompt, music_length_ms: Math.round(lengthMs), model_id: cfg.musicModel };
}

/** Text-to-sound-effect: POST {base}/v1/sound-generation. */
export function generateSfx(o: ElevenLabsOptions, r: SfxRequest): Promise<Uint8Array> {
  return postForAudio(o, "/v1/sound-generation", sfxBody(r, o.services));
}

/** Music: POST {base}/v1/music with a prompt and length in ms. */
export function composeMusic(o: ElevenLabsOptions, prompt: string, lengthMs: number): Promise<Uint8Array> {
  return postForAudio(o, "/v1/music", musicBody(prompt, lengthMs, o.services));
}

/** Text-to-speech with a fixed voice: POST {base}/v1/text-to-speech/{voice_id}. */
export function textToSpeech(o: ElevenLabsOptions, voiceId: string, text: string): Promise<Uint8Array> {
  if (!voiceId) throw new Error("textToSpeech needs a voice ID");
  const model_id = (o.services ?? defaultServices).elevenlabs.ttsModel;
  return postForAudio(o, `/v1/text-to-speech/${encodeURIComponent(voiceId)}`, { text, model_id });
}
