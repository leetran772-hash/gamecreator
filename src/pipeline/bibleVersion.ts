// Bible versioning: every asset records the bible version it was built
// against. After a bible change (e.g. palette), bump the version, list the
// affected assets, and either re-material them (cheap, local Blender re-run)
// or regenerate them (paid, gated).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Bible } from "../bible/types";
import { AssetPipeline, type Clients } from "./assetPipeline";
import { isModelKind, loadRegistry, staleAssets as staleIn, type AnyAssetKind } from "./registry";

/** Increments bible meta.version (meta.json) and returns the new version. */
export function bumpBibleVersion(projectDir: string): number {
  const p = join(projectDir, "bible", "meta.json");
  const meta = JSON.parse(readFileSync(p, "utf8")) as Bible["meta"];
  meta.version = (meta.version ?? 0) + 1;
  writeFileSync(p, JSON.stringify(meta, null, 2) + "\n");
  return meta.version;
}

export interface StaleAsset {
  id: string;
  kind: AnyAssetKind;
  bibleVersion: number;
  /** rematerial: a raw model exists, re-run Blender only (free). regenerate: paid redo. */
  action: "rematerial" | "regenerate";
}

/** Non-locked assets built against an older bible version than the current one, with the suggested fix. */
export function staleAssets(projectDir: string): { bibleVersion: number; stale: StaleAsset[] } {
  const meta = JSON.parse(readFileSync(join(projectDir, "bible", "meta.json"), "utf8")) as Bible["meta"];
  const stale = staleIn(loadRegistry(projectDir), meta.version).map((a) => ({
    id: a.id,
    kind: a.kind,
    bibleVersion: a.bibleVersion,
    action: isModelKind(a.kind) && a.rawModel ? ("rematerial" as const) : ("regenerate" as const),
  }));
  return { bibleVersion: meta.version, stale };
}

/** Re-runs only Blender cleanup (palette snap etc.) on an existing raw model and stamps the current bible version. No spend. */
export function rematerial(projectDir: string, id: string, clients: Clients) {
  return new AssetPipeline(projectDir, clients).rematerial(id);
}
