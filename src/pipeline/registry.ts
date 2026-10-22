// Asset registry: the data behind the asset browser. Lives in the project
// folder as assets.json, so it is versioned with everything else.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssetKind } from "./conceptPrompt";

export type AssetStatus = "concept" | "approved" | "3d" | "cleaned" | "in-game";
export const STATUS_ORDER: AssetStatus[] = ["concept", "approved", "3d", "cleaned", "in-game"];

export interface CostEntry {
  service: "openai" | "meshy" | "elevenlabs" | "anthropic";
  step: string;
  usd: number;
  credits?: number;
  at: string;
}

export interface AssetRecord {
  id: string;
  subject: string;
  kind: AssetKind;
  description: string;
  status: AssetStatus;
  source: "generated" | "imported";
  /** Imported or hand-fixed assets are locked: the agent never regenerates them. */
  locked: boolean;
  license?: { origin: string; terms: string };
  /** Bible version the asset was built against. */
  bibleVersion: number;
  conceptPrompt?: string;
  concept?: string;
  meshyTaskId?: string;
  rawModel?: string;
  model?: string;
  stats?: { triangles: number; lods: number[]; height: number };
  costs: CostEntry[];
}

export interface Registry {
  assets: AssetRecord[];
}

export const registryPath = (projectDir: string) => join(projectDir, "assets.json");

export function loadRegistry(projectDir: string): Registry {
  const p = registryPath(projectDir);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Registry) : { assets: [] };
}

export function saveRegistry(projectDir: string, reg: Registry) {
  writeFileSync(registryPath(projectDir), JSON.stringify(reg, null, 2) + "\n");
}

export const normalizeSubject = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export function slugify(s: string): string {
  return normalizeSubject(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "asset";
}

export function uniqueId(reg: Registry, subject: string): string {
  const base = slugify(subject);
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
