// Generated audio: ElevenLabs SFX, music and character voice lines, always
// finished the same way as imported audio: loudness-normalized OGG Vorbis,
// with loop points for music, registered in assets.json.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative } from "node:path";
import type { Bible } from "../bible/types";
import { loadBibleFrom } from "./assetPipeline";
import { composeMusic, generateSfx, textToSpeech, type SfxRequest } from "./elevenlabs";
import { estimateMusic, estimateSfx, estimateVoiceLines, gate, type Estimate } from "./gates";
import { audioExtension, LOUDNESS_TARGETS, mediaTools, processAudioToOgg, sineWav, type MediaTools } from "./media";
import {
  findAsset,
  loadRegistry,
  normalizeSubject,
  saveRegistry,
  uniqueId,
  type AssetRecord,
  type AudioKind,
  type CostEntry,
  type Registry,
} from "./registry";
import { defaultServices, type Fetch, type Services } from "./services";

/** The ElevenLabs calls the audio pipeline makes. Swappable for tests and dry runs. */
export interface AudioClients {
  sfx(req: SfxRequest): Promise<Uint8Array>;
  music(prompt: string, lengthMs: number): Promise<Uint8Array>;
  tts(voiceId: string, text: string): Promise<Uint8Array>;
}

/** Real ElevenLabs calls; needs ELEVENLABS_API_KEY. */
export function liveAudioClients(env = process.env, services: Services = defaultServices, f?: Fetch): AudioClients {
  const o = () => {
    const apiKey = env.ELEVENLABS_API_KEY;
    if (!apiKey) throw new Error("Set ELEVENLABS_API_KEY to call ElevenLabs (or use --dry-run).");
    return { apiKey, services, fetch: f };
  };
  return {
    sfx: (req) => generateSfx(o(), req),
    music: (prompt, ms) => composeMusic(o(), prompt, ms),
    tts: (voiceId, text) => textToSpeech(o(), voiceId, text),
  };
}

/** No network, no spend: real short sine-tone WAVs, so the ffmpeg processing still runs for real. */
export function dryRunAudioClients(tools: MediaTools = mediaTools()): AudioClients {
  const tone = (seconds: number, freq: number) => {
    const dir = mkdtempSync(join(tmpdir(), "gc-tone-"));
    try {
      const f = join(dir, "tone.wav");
      sineWav(f, seconds, freq, tools);
      return new Uint8Array(readFileSync(f));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  return {
    sfx: async (req) => tone(req.durationSeconds ?? 1.5, 660),
    music: async (_p, ms) => tone(Math.min(ms / 1000, 8), 220),
    tts: async (_v, text) => tone(Math.min(6, Math.max(1, text.length * 0.06)), 330),
  };
}

/** SFX prompt: the request plus the bible's SFX style notes. */
export function buildSfxPrompt(bible: Bible, description: string): string {
  return `${description.trim().replace(/\.$/, "")}. Sound style: ${bible.audio.sfxStyle}`;
}

/** Music prompt from a bible mood key (audio.musicMoods) or, failing that, free text. */
export function buildMusicPrompt(bible: Bible, mood: string): string {
  const moodText = bible.audio.musicMoods[mood];
  return [
    `Instrumental background music for the game "${bible.meta.title}" (${bible.meta.genre}; ${bible.meta.style}).`,
    moodText ? `Mood "${mood}": ${moodText}.` : `Mood: ${mood}.`,
    /loop/i.test(moodText ?? mood) ? "Must loop seamlessly: no intro or fade-out." : "",
    "No vocals.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** The fixed ElevenLabs voice for a character, from bible audio.voices. Throws a clear error if it is not set. */
export function voiceIdFor(bible: Bible, characterId: string): string {
  const v = bible.audio.voices[characterId];
  if (!v) throw new Error(`No voice for "${characterId}" in bible audio.voices (known: ${Object.keys(bible.audio.voices).join(", ") || "none"})`);
  if (!v.voiceId?.trim())
    throw new Error(`Character "${characterId}" has no voice ID yet. Set audio.voices.${characterId}.voiceId in bible/audio.json (one fixed ElevenLabs voice per character).`);
  return v.voiceId.trim();
}

export interface VoiceLine {
  characterId: string;
  text: string;
  /** Optional asset id; derived from character + line otherwise. */
  id?: string;
  tags?: string[];
}

export interface AudioGenOptions {
  /** Cost gate: true only once the user said yes. */
  approved: boolean;
  /** Generate again even if the same request is already in the registry. */
  force?: boolean;
  tags?: string[];
}

/**
 * Raw audio file -> loudness-normalized OGG under assets/audio/<id>.ogg, with
 * duration (and loop points for music) written onto the asset record.
 * Shared by generated and imported audio.
 */
export function finishAudioAsset(
  projectDir: string,
  asset: AssetRecord,
  rawFile: string,
  kind: AudioKind,
  loop: { start?: number; end?: number } = {},
  tools: MediaTools = mediaTools(),
): AssetRecord {
  const out = join(projectDir, "assets", "audio", `${asset.id}.ogg`);
  const r = processAudioToOgg(rawFile, out, LOUDNESS_TARGETS[kind], tools);
  const rel = (p: string) => relative(projectDir, p).split("\\").join("/");
  asset.audio = { file: rel(out), duration: round3(r.duration), ...(r.lufs !== undefined ? { lufs: r.lufs } : {}) };
  if (kind === "music") {
    const start = clamp(loop.start ?? 0, 0, r.duration);
    const end = clamp(loop.end ?? r.duration, start, r.duration);
    if (end - start <= 0) throw new Error(`Loop points ${start}-${end}s leave nothing to loop in ${asset.id}`);
    Object.assign(asset.audio, { loopStart: round3(start), loopEnd: round3(end) });
  }
  asset.files = { ...asset.files, raw: rel(rawFile) };
  asset.status = "cleaned";
  return asset;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export class AudioPipeline {
  constructor(
    readonly projectDir: string,
    readonly clients: AudioClients,
    readonly services: Services = defaultServices,
    readonly log: (msg: string) => void = () => {},
    readonly tools: MediaTools = mediaTools(),
  ) {}

  private cached(reg: Registry, subject: string, force?: boolean): AssetRecord | undefined {
    const hit = reg.assets.find((a) => normalizeSubject(a.subject) === normalizeSubject(subject));
    if (hit && (hit.locked || !force)) {
      this.log(`Cache hit: "${subject}" is already ${hit.id}${hit.locked ? " (locked)" : ""}.`);
      return hit;
    }
    return undefined;
  }

  private record(reg: Registry, existing: AssetRecord | undefined, subject: string, kind: AudioKind, bible: Bible, id?: string): AssetRecord {
    if (existing) return existing;
    if (id && reg.assets.some((a) => a.id === id)) throw new Error(`Asset id "${id}" is already taken`);
    const asset: AssetRecord = {
      id: id ?? uniqueId(reg, subject, 48),
      subject,
      kind,
      description: "",
      status: "concept",
      source: "generated",
      locked: false,
      tags: [],
      bibleVersion: bible.meta.version,
      costs: [],
    };
    reg.assets.push(asset);
    return asset;
  }

  private store(asset: AssetRecord, bytes: Uint8Array, kind: AudioKind, loop?: { start?: number; end?: number }) {
    const raw = join(this.projectDir, "assets", "audio", "raw", `${asset.id}.${audioExtension(bytes)}`);
    mkdirSync(dirname(raw), { recursive: true });
    writeFileSync(raw, bytes);
    finishAudioAsset(this.projectDir, asset, raw, kind, loop, this.tools);
    this.log(`  -> ${asset.audio!.file} (${asset.audio!.duration}s, ${extname(raw).slice(1)} -> ogg)`);
  }

  private cost(e: Estimate, usd = e.usd): CostEntry {
    return { service: e.service, step: e.step, usd, at: new Date().toISOString() };
  }

  /** ElevenLabs sound effect styled by bible audio.sfxStyle. Gated; repeats hit the cache unless force. */
  async sfx(
    description: string,
    o: AudioGenOptions & { durationSeconds?: number; promptInfluence?: number },
  ): Promise<{ asset: AssetRecord; cached: boolean }> {
    const reg = loadRegistry(this.projectDir);
    const subject = `sfx: ${description}`;
    const hit = this.cached(reg, subject, o.force);
    if (hit) return { asset: hit, cached: true };
    const est = gate(estimateSfx(this.services), o.approved);
    const bible = loadBibleFrom(this.projectDir);
    const prompt = buildSfxPrompt(bible, description);
    this.log(`Generating SFX "${description}"...`);
    const bytes = await this.clients.sfx({ text: prompt, durationSeconds: o.durationSeconds, promptInfluence: o.promptInfluence });
    const asset = this.record(reg, reg.assets.find((a) => normalizeSubject(a.subject) === normalizeSubject(subject)), subject, "sfx", bible);
    Object.assign(asset, { description, audioPrompt: prompt, bibleVersion: bible.meta.version, tags: uniq(["sfx", ...(o.tags ?? []), ...asset.tags]) });
    this.store(asset, bytes, "sfx");
    asset.costs.push(this.cost(est));
    saveRegistry(this.projectDir, reg);
    return { asset, cached: false };
  }

  /** ElevenLabs music for a bible mood (audio.musicMoods key) or free-text mood. Loop points default to the whole track. Gated. */
  async music(
    mood: string,
    o: AudioGenOptions & { seconds?: number; loopStart?: number; loopEnd?: number },
  ): Promise<{ asset: AssetRecord; cached: boolean }> {
    const reg = loadRegistry(this.projectDir);
    const subject = `music: ${mood}`;
    const hit = this.cached(reg, subject, o.force);
    if (hit) return { asset: hit, cached: true };
    const seconds = o.seconds ?? 60;
    const est = gate(estimateMusic(seconds, this.services), o.approved);
    const bible = loadBibleFrom(this.projectDir);
    const prompt = buildMusicPrompt(bible, mood);
    this.log(`Composing ${seconds}s of "${mood}" music...`);
    const bytes = await this.clients.music(prompt, seconds * 1000);
    const asset = this.record(reg, reg.assets.find((a) => normalizeSubject(a.subject) === normalizeSubject(subject)), subject, "music", bible);
    Object.assign(asset, {
      description: bible.audio.musicMoods[mood] ?? mood,
      audioPrompt: prompt,
      bibleVersion: bible.meta.version,
      tags: uniq(["music", mood, ...(o.tags ?? []), ...asset.tags]),
    });
    this.store(asset, bytes, "music", { start: o.loopStart, end: o.loopEnd });
    asset.costs.push(this.cost(est));
    saveRegistry(this.projectDir, reg);
    return { asset, cached: false };
  }

  /** One character voice line with the character's fixed bible voice. Gated (same as a batch of one). */
  async voice(characterId: string, text: string, o: AudioGenOptions): Promise<{ asset: AssetRecord; cached: boolean }> {
    const r = await this.voiceBatch([{ characterId, text, tags: o.tags }], o);
    return { asset: r.assets[0]!, cached: r.cached.length > 0 };
  }

  /**
   * Many voice lines behind ONE cost gate with a combined estimate (total
   * characters of the lines that are not cached). Every character must have a
   * voice ID in the bible before anything is asked or spent.
   */
  async voiceBatch(lines: VoiceLine[], o: Omit<AudioGenOptions, "tags">): Promise<{ assets: AssetRecord[]; cached: string[]; estimate?: Estimate }> {
    if (!lines.length) throw new Error("voiceBatch needs at least one line");
    const bible = loadBibleFrom(this.projectDir);
    const problems: string[] = [];
    const voiceIds = new Map<string, string>();
    for (const l of lines) {
      if (!l.text?.trim()) problems.push(`empty line for "${l.characterId}"`);
      if (voiceIds.has(l.characterId)) continue;
      try {
        voiceIds.set(l.characterId, voiceIdFor(bible, l.characterId));
      } catch (e) {
        problems.push((e as Error).message);
      }
    }
    if (problems.length) throw new Error(`Voice batch refused:\n- ${[...new Set(problems)].join("\n- ")}`);

    const reg = loadRegistry(this.projectDir);
    const subjectOf = (l: VoiceLine) => `voice: ${l.characterId}: ${l.text.trim()}`;
    const hits = lines.map((l) => this.cached(reg, subjectOf(l), o.force));
    const cachedIds = hits.filter((h): h is AssetRecord => !!h).map((h) => h.id);
    const todo = lines.filter((_, i) => !hits[i]);
    if (!todo.length) return { assets: hits as AssetRecord[], cached: cachedIds };

    const est = gate(estimateVoiceLines(todo, this.services), o.approved);
    const totalChars = todo.reduce((n, l) => n + l.text.length, 0);
    this.log(`Voicing ${todo.length} line(s) (${totalChars} characters)...`);
    const out: AssetRecord[] = [];
    for (const [i, l] of lines.entries()) {
      const hit = hits[i];
      if (hit) {
        out.push(hit);
        continue;
      }
      const voiceId = voiceIds.get(l.characterId)!;
      const bytes = await this.clients.tts(voiceId, l.text.trim());
      const subject = subjectOf(l);
      const existing = reg.assets.find((a) => normalizeSubject(a.subject) === normalizeSubject(subject));
      const asset = this.record(reg, existing, subject, "voice", bible, existing ? undefined : l.id ?? uniqueId(reg, `voice ${l.characterId} ${l.text}`, 48));
      Object.assign(asset, {
        description: l.text.trim(),
        voice: { characterId: l.characterId, voiceId, text: l.text.trim() },
        bibleVersion: bible.meta.version,
        tags: uniq(["voice", l.characterId, ...(l.tags ?? []), ...asset.tags]),
      });
      this.store(asset, bytes, "voice");
      asset.costs.push(this.cost(est, (est.usd * l.text.length) / totalChars));
      saveRegistry(this.projectDir, reg); // keep progress if a later line fails
      out.push(asset);
    }
    return { assets: out, cached: cachedIds, estimate: est };
  }

  /** Re-runs the original ElevenLabs request for a generated audio asset (gated). Refuses locked assets. */
  async regenerate(id: string, approved: boolean): Promise<AssetRecord> {
    const asset = findAsset(loadRegistry(this.projectDir), id);
    if (asset.locked) throw new Error(`${id} is locked; it will not be regenerated`);
    if (asset.kind === "sfx") return (await this.sfx(asset.description, { approved, force: true, durationSeconds: asset.audio?.duration })).asset;
    if (asset.kind === "music") {
      const mood = asset.subject.replace(/^music:\s*/, "");
      return (await this.music(mood, { approved, force: true, seconds: Math.round(asset.audio?.duration ?? 60) })).asset;
    }
    if (asset.kind === "voice" && asset.voice) return (await this.voice(asset.voice.characterId, asset.voice.text, { approved, force: true })).asset;
    throw new Error(`${id} (${asset.kind}) is not generated audio`);
  }
}

const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
