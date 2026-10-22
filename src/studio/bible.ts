// Bible edits from the agent (MCP) and the user (studio editor). Every saved
// change is validated and bumps the bible version, so assets built against
// the old version show up as stale.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Bible } from "../bible/types";
import { validateBible } from "../bible/validate";
import { loadBibleFrom } from "../pipeline/assetPipeline";

export const LAYERS = ["meta", "visual", "audio", "lore", "code"] as const;
export type Layer = (typeof LAYERS)[number];

const layerPath = (dir: string, layer: Layer) => join(dir, "bible", `${layer}.json`);

export function readLayer(dir: string, layer: Layer): unknown {
  if (!LAYERS.includes(layer)) throw new Error(`Unknown bible layer "${layer}"`);
  return JSON.parse(readFileSync(layerPath(dir, layer), "utf8"));
}

/**
 * Validates and saves one layer, bumping meta.version when anything changed.
 * Only the user can approve the bible: an agent write keeps the current approval flag.
 */
export function writeLayer(dir: string, layer: Layer, data: unknown, by: "agent" | "user"): { version: number; changed: boolean } {
  const bible = loadBibleFrom(dir) as unknown as Record<Layer, unknown>;
  const before = JSON.stringify(bible[layer]);
  const next = structuredClone(data) as Record<string, unknown>;
  if (layer === "meta") {
    const cur = bible.meta as Bible["meta"];
    next.version = cur.version;
    if (by === "agent") next.approved = cur.approved;
  }
  bible[layer] = next;
  const problems = validateBible(bible as unknown as Bible);
  if (problems.length) throw new Error(`Bible not saved; fix these first:\n- ${problems.join("\n- ")}`);
  const changed = JSON.stringify(next) !== before;
  const meta = bible.meta as Bible["meta"];
  if (changed && !(layer === "meta" && onlyApprovalChanged(JSON.parse(before), next))) meta.version += 1;
  if (layer !== "meta") writeFileSync(layerPath(dir, layer), JSON.stringify(next, null, 2) + "\n");
  writeFileSync(layerPath(dir, "meta"), JSON.stringify(meta, null, 2) + "\n");
  return { version: meta.version, changed };
}

function onlyApprovalChanged(a: Record<string, unknown>, b: Record<string, unknown>) {
  return JSON.stringify({ ...a, approved: null, version: null }) === JSON.stringify({ ...b, approved: null, version: null });
}

/** User action: approve (or un-approve) the bible. */
export function setBibleApproved(dir: string, approved: boolean) {
  const meta = readLayer(dir, "meta") as Bible["meta"];
  meta.approved = approved;
  writeFileSync(layerPath(dir, "meta"), JSON.stringify(meta, null, 2) + "\n");
}

/** Points a bible entity (player, enemy id, or item id) at a cleaned model. */
export function setEntityModel(dir: string, entity: string, modelPath: string | undefined, by: "agent" | "user") {
  const lore = readLayer(dir, "lore") as Bible["lore"];
  const target =
    entity === "player" ? lore.player : (lore.bestiary[entity] as { model?: string } | undefined) ?? (lore.items[entity] as { model?: string } | undefined);
  if (!target) throw new Error(`No entity "${entity}" (use "player", an enemy id or an item id)`);
  if (modelPath) target.model = modelPath;
  else delete target.model;
  return writeLayer(dir, "lore", lore, by);
}
