import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bible } from "../projects/dungeon-crawler/index";
import type { AudioLayer } from "../src/bible/types";
import { AudioPipeline, buildMusicPrompt, buildSfxPrompt, dryRunAudioClients, liveAudioClients } from "../src/pipeline/audioPipeline";
import { musicBody, sfxBody } from "../src/pipeline/elevenlabs";
import { ApprovalRequired, estimateVoiceLines } from "../src/pipeline/gates";
import { LOUDNESS_TARGETS, measureLoudness, probeAudio, sineWav } from "../src/pipeline/media";
import { loadRegistry } from "../src/pipeline/registry";
import { defaultServices } from "../src/pipeline/services";
import { editBible, tmpProject } from "./helpers";

const BASE = defaultServices.elevenlabs.baseUrl;

/** A real short WAV, standing in for ElevenLabs' audio response. */
function toneBytes(seconds = 1.5, freq = 440): Uint8Array {
  const f = join(mkdtempSync(join(tmpdir(), "gc-wav-")), "t.wav");
  sineWav(f, seconds, freq);
  return new Uint8Array(readFileSync(f));
}

type Call = { url: string; init: RequestInit };
function mockElevenLabs(seconds = 1.5) {
  const calls: Call[] = [];
  const bytes = toneBytes(seconds);
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(new Uint8Array(bytes), { status: 200, headers: { "Content-Type": "audio/wav" } });
  }) as unknown as typeof fetch;
  const body = (i: number) => JSON.parse(String(calls[i]!.init.body));
  const header = (i: number, k: string) => (calls[i]!.init.headers as Record<string, string>)[k];
  return { f, calls, body, header };
}

const withVoices = (dir: string) =>
  editBible<AudioLayer>(dir, "audio", (a) => {
    a.voices.hero!.voiceId = "voice-hero-123";
  });

const live = (f: typeof fetch) => liveAudioClients({ ELEVENLABS_API_KEY: "xi-test" }, defaultServices, f);

describe("ElevenLabs request shapes", () => {
  it("SFX: POST /v1/sound-generation with xi-api-key, bible sfxStyle in the prompt, duration and influence", async () => {
    const dir = tmpProject();
    const m = mockElevenLabs();
    const p = new AudioPipeline(dir, live(m.f));
    const { asset } = await p.sfx("bone clatter on stone", { approved: true, durationSeconds: 1.5, promptInfluence: 0.5 });
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.url).toBe(`${BASE}/v1/sound-generation`);
    expect(m.calls[0]!.init.method).toBe("POST");
    expect(m.header(0, "xi-api-key")).toBe("xi-test");
    expect(m.body(0)).toMatchObject({ duration_seconds: 1.5, prompt_influence: 0.5 });
    expect(m.body(0).text).toContain("bone clatter on stone");
    expect(m.body(0).text).toContain(bible.audio.sfxStyle);
    expect(asset.tags).toContain("sfx");
    expect(asset.costs.map((c) => c.service)).toEqual(["elevenlabs"]);
  });

  it("music: POST /v1/music with the bible mood and music_length_ms", async () => {
    const dir = tmpProject();
    const m = mockElevenLabs(4);
    const p = new AudioPipeline(dir, live(m.f));
    const { asset } = await p.music("combat", { approved: true, seconds: 30 });
    expect(m.calls[0]!.url).toBe(`${BASE}/v1/music`);
    expect(m.body(0).music_length_ms).toBe(30_000);
    expect(m.body(0).prompt).toContain(bible.audio.musicMoods.combat);
    expect(m.body(0).prompt).toContain("loop");
    expect(asset.tags).toEqual(expect.arrayContaining(["music", "combat"]));
  });

  it("voice: POST /v1/text-to-speech/{the character's bible voice id} with text and model_id", async () => {
    const dir = tmpProject();
    withVoices(dir);
    const m = mockElevenLabs();
    const p = new AudioPipeline(dir, live(m.f));
    const { asset } = await p.voice("hero", "Not today.", { approved: true });
    expect(m.calls[0]!.url).toBe(`${BASE}/v1/text-to-speech/voice-hero-123`);
    expect(m.header(0, "xi-api-key")).toBe("xi-test");
    expect(m.body(0)).toEqual({ text: "Not today.", model_id: defaultServices.elevenlabs.ttsModel });
    expect(asset.voice).toEqual({ characterId: "hero", voiceId: "voice-hero-123", text: "Not today." });
    expect(asset.tags).toEqual(expect.arrayContaining(["voice", "hero"]));
  });

  it("validates lengths and builds prompts from the bible", () => {
    expect(() => sfxBody({ text: "x", durationSeconds: 45 })).toThrow(/duration/);
    expect(() => musicBody("x", 1000)).toThrow(/length/);
    expect(buildSfxPrompt(bible, "door creak.")).toBe(`door creak. Sound style: ${bible.audio.sfxStyle}`);
    expect(buildMusicPrompt(bible, "explore")).toContain(bible.audio.musicMoods.explore);
    expect(buildMusicPrompt(bible, "tavern ambience")).toContain("Mood: tavern ambience");
  });

  it("surfaces API errors", async () => {
    const dir = tmpProject();
    const f = (async () => new Response("quota exceeded", { status: 401 })) as unknown as typeof fetch;
    await expect(new AudioPipeline(dir, live(f)).sfx("x", { approved: true })).rejects.toThrow(/ElevenLabs request failed \(401\)/);
  });
});

describe("audio gates and voice batching", () => {
  it("stops at the gate without calling ElevenLabs, then caches repeats", async () => {
    const dir = tmpProject();
    const m = mockElevenLabs();
    const p = new AudioPipeline(dir, live(m.f));
    await expect(p.sfx("door creak", { approved: false })).rejects.toBeInstanceOf(ApprovalRequired);
    await expect(p.music("combat", { approved: false })).rejects.toBeInstanceOf(ApprovalRequired);
    expect(m.calls).toHaveLength(0);
    await p.sfx("door creak", { approved: true });
    const again = await p.sfx("Door  creak", { approved: false });
    expect(again.cached).toBe(true);
    expect(m.calls).toHaveLength(1);
  });

  it("refuses characters without a voice id before asking for money", async () => {
    const dir = tmpProject();
    const m = mockElevenLabs();
    const p = new AudioPipeline(dir, live(m.f));
    const err = await p.voiceBatch([{ characterId: "warden", text: "Riddle me." }], { approved: false }).catch((e) => e);
    expect(err).not.toBeInstanceOf(ApprovalRequired);
    expect(String(err)).toMatch(/warden.*no voice ID/);
    await expect(p.voice("nobody", "hi", { approved: true })).rejects.toThrow(/No voice for "nobody"/);
    expect(m.calls).toHaveLength(0);
  });

  it("puts a whole batch behind one gate with a combined estimate", async () => {
    const dir = tmpProject();
    editBible<AudioLayer>(dir, "audio", (a) => {
      a.voices.hero!.voiceId = "voice-hero-123";
      a.voices.warden!.voiceId = "voice-warden-9";
    });
    const m = mockElevenLabs(1);
    const p = new AudioPipeline(dir, live(m.f));
    const lines = [
      { characterId: "hero", text: "Another floor down." },
      { characterId: "warden", text: "The candle gutters, yet you climb." },
      { characterId: "hero", text: "Not today." },
    ];
    const err = (await p.voiceBatch(lines, { approved: false }).catch((e) => e)) as ApprovalRequired;
    expect(err).toBeInstanceOf(ApprovalRequired);
    expect(err.estimate).toEqual(estimateVoiceLines(lines));
    expect(err.estimate.detail).toContain("3 voice line(s)");
    expect(m.calls).toHaveLength(0);

    const r = await p.voiceBatch(lines, { approved: true });
    expect(r.assets).toHaveLength(3);
    expect(m.calls.map((c) => c.url.split("/").pop())).toEqual(["voice-hero-123", "voice-warden-9", "voice-hero-123"]);
    const spent = r.assets.reduce((s, a) => s + a.costs[0]!.usd, 0);
    expect(spent).toBeCloseTo(err.estimate.usd, 6);

    // Re-running the same batch plus one new line only gates and pays for the new line.
    const more = [...lines, { characterId: "warden", text: "Down, always down." }];
    const r2 = await p.voiceBatch(more, { approved: true });
    expect(r2.cached).toHaveLength(3);
    expect(r2.estimate?.detail).toContain("1 voice line(s)");
    expect(r2.assets.map((a) => a.voice?.text)).toEqual(more.map((l) => l.text));
    expect(m.calls).toHaveLength(4);
    expect(loadRegistry(dir).assets).toHaveLength(4);
  });
});

describe("audio processing (real ffmpeg)", () => {
  it("normalizes loudness, converts to OGG Vorbis and stores loop points for music", async () => {
    const dir = tmpProject();
    const p = new AudioPipeline(dir, dryRunAudioClients());
    const sfx = (await p.sfx("bone clatter", { approved: true, durationSeconds: 2 })).asset;
    const music = (await p.music("explore", { approved: true, seconds: 6 })).asset;

    for (const [a, target] of [
      [sfx, LOUDNESS_TARGETS.sfx],
      [music, LOUDNESS_TARGETS.music],
    ] as const) {
      const file = join(dir, a.audio!.file);
      expect(a.audio!.file).toMatch(/^assets\/audio\/.+\.ogg$/);
      const probe = probeAudio(file);
      expect(probe.format).toContain("ogg");
      expect(probe.codec).toBe("vorbis");
      expect(probe.duration).toBeGreaterThan(0);
      expect(Math.abs(measureLoudness(file) - target)).toBeLessThan(1.5);
      expect(existsSync(join(dir, a.files!.raw!))).toBe(true);
      expect(a.status).toBe("cleaned");
    }
    // The raw sine is much quieter than the target: normalization really changed it.
    expect(measureLoudness(join(dir, sfx.files!.raw!))).toBeLessThan(LOUDNESS_TARGETS.sfx - 3);
    expect(sfx.audio!.duration).toBeCloseTo(2, 1);
    expect(sfx.audio!.loopEnd).toBeUndefined();
    expect(music.audio!.loopStart).toBe(0);
    expect(music.audio!.loopEnd).toBeCloseTo(music.audio!.duration, 3);

    const custom = (await p.music("combat", { approved: true, seconds: 6, loopStart: 1, loopEnd: 5 })).asset;
    expect([custom.audio!.loopStart, custom.audio!.loopEnd]).toEqual([1, 5]);
  }, 30_000);
});
