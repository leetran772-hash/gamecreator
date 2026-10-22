// Asset registry: the data behind the asset browser. Lives in the project
// folder as assets.json, so it is versioned with everything else.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssetKind } from "./conceptPrompt";

export type AssetStatus = "concept" | "approved" | "3d" | "cleaned" | "in-game";
export const STATUS_ORDER: AssetStatus[] = ["concept", "approved", "3d", "cleaned", "in-game"];

export type AudioKind = "music" | "sfx" | "voice";
export type ImageKind = "texture" | "image" | "reference";
/** 3D kinds (AssetKind) plus audio, image and font assets. */
export type AnyAssetKind = AssetKind | AudioKind | ImageKind | "font";

export const MODEL_KINDS: readonly AssetKind[] = ["character", "creature", "prop", "environment"];
export const AUDIO_KINDS: readonly AudioKind[] = ["music", "sfx", "voice"];
export const isModelKind = (k: string): k is AssetKind => (MODEL_KINDS as readonly string[]).includes(k);
export const isAudioKind = (k: string): k is AudioKind => (AUDIO_KINDS as readonly string[]).includes(k);

export type LicenseOrigin = "purchased-pack" | "commissioned" | "royalty-free" | "in-house";
export const LICENSE_ORIGINS: readonly LicenseOrigin[] = ["purchased-pack", "commissioned", "royalty-free", "in-house"];

export interface CostEntry {
  service: "openai" | "meshy" | "elevenlabs" | "anthropic";
  step: string;
  usd: number;
  credits?: number;
  at: string;
}

export interface AudioInfo {
  /** Processed OGG, relative to the project folder. */
  file: string;
  /** Seconds (ffprobe). */
  duration: number;
  /** Music loop points in seconds (default: the whole track). */
  loopStart?: number;
  loopEnd?: number;
  /** Integrated loudness target (LUFS) the file was normalized to, if it was. */
  lufs?: number;
}

export interface AssetRecord {
  id: string;
  subject: string;
  kind: AnyAssetKind;
  description: string;
  status: AssetStatus;
  source: "generated" | "imported";
  /** Imported or hand-fixed assets are locked: the agent never regenerates them. */
  locked: boolean;
  license?: { origin: LicenseOrigin | string; terms: string };
  /** Bible tags: mood, area or character ("boss battle", "tavern", "warden"). */
  tags: string[];
  /** Bible version the asset was built against. */
  bibleVersion: number;
  conceptPrompt?: string;
  concept?: string;
  meshyTaskId?: string;
  rawModel?: string;
  model?: string;
  stats?: { triangles: number; lods: number[]; height: number };
  /** Audio assets: processed OGG and its timing. */
  audio?: AudioInfo;
  /** Prompt sent to ElevenLabs (generated audio). */
  audioPrompt?: string;
  /** Voice lines: who says what, with which fixed voice. */
  voice?: { characterId: string; voiceId: string; text: string };
  /** Other files by role, relative to the project folder (original, image, thumbnail, icon, font). */
  files?: Record<string, string>;
  costs: CostEntry[];
}

export interface Registry {
  assets: AssetRecord[];
}

export const registryPath = (projectDir: string) => join(projectDir, "assets.json");

export function loadRegistry(projectDir: string): Registry {
  const p = registryPath(projectDir);
  const reg = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Registry) : { assets: [] };
  for (const a of reg.assets) a.tags ??= []; // records written before tags existed
  return reg;
}

export function saveRegistry(projectDir: string, reg: Registry) {
  writeFileSync(registryPath(projectDir), JSON.stringify(reg, null, 2) + "\n");
}

export const normalizeSubject = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export function slugify(s: string): string {
  return normalizeSubject(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "asset";
}

export function uniqueId(reg: Registry, subject: string, maxLength = 32): string {
  const slug = slugify(subject);
  // Cut at a word boundary so ids stay short and readable.
  const cut = slug.length <= maxLength ? slug : slug.slice(0, maxLength).replace(/-[^-]*$/, "") || slug.slice(0, maxLength);
  const base = cut.replace(/-$/, "");
  let id = base;
  for (let i = 2; reg.assets.some((a) => a.id === id); i++) id = `${base}-${i}`;
  return id;
}

export function findAsset(reg: Registry, id: string): AssetRecord {
  const a = reg.assets.find((x) => x.id === id);
  if (!a) throw new Error(`No asset "${id}". Known: ${reg.assets.map((x) => x.id).join(", ") || "none"}`);
  return a;
}

export const totalCost = (reg: Registry) => reg.assets.flatMap((a) => a.costs).reduce((s, c) => s + c.usd, 0);

/** Assets built against an older bible version (candidates for regeneration). */
export const staleAssets = (reg: Registry, bibleVersion: number) =>
  reg.assets.filter((a) => !a.locked && a.bibleVersion < bibleVersion);
