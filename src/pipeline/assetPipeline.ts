// Generated 3D: concept (GPT) -> user approval -> Meshy image-to-3D -> Blender cleanup.
// The approved GPT concept image is the exact picture Meshy models from.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Bible } from "../bible/types";
import { buildAssetConceptPrompt, polyBudgetFor, type AssetKind } from "./conceptPrompt";
import { combineEstimates, estimateConcept, estimateMeshy, gate, type Estimate } from "./gates";
import { createImageTo3D, downloadBytes, toDataUri, waitForImageTo3D, type MeshyTask } from "./meshy";
import { generateImage } from "./openaiImages";
import { boxGlb, PLACEHOLDER_PNG } from "./placeholderGlb";
import {
  findAsset,
  isModelKind,
  loadRegistry,
  normalizeSubject,
  saveRegistry,
  STATUS_ORDER,
  uniqueId,
  type AssetRecord,
  type CostEntry,
} from "./registry";
import { defaultServices, type Services } from "./services";

const BIBLE_LAYERS = ["meta", "visual", "audio", "lore", "code"] as const;

export function loadBibleFrom(projectDir: string): Bible {
  const out: Record<string, unknown> = {};
  for (const layer of BIBLE_LAYERS) out[layer] = JSON.parse(readFileSync(join(projectDir, "bible", `${layer}.json`), "utf8"));
  return out as unknown as Bible;
}

/** The services the pipeline calls. Swappable for tests and dry runs. */
export interface Clients {
  image(prompt: string, references: { name: string; bytes: Uint8Array; mime: string }[]): Promise<Uint8Array>;
  meshy(imageDataUri: string, targetPolycount: number, onProgress?: (t: MeshyTask) => void): Promise<Uint8Array>;
  blender(input: string, output: string, settings: object): { triangles: number; lods: number[]; height: number };
}

export function liveClients(env = process.env, services: Services = defaultServices): Clients {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`Set ${k} to call this service (or use --dry-run).`);
    return v;
  };
  return {
    image: (prompt, references) => generateImage({ prompt, references, apiKey: need("OPENAI_API_KEY"), services }),
    async meshy(uri, polycount, onProgress) {
      const o = { apiKey: need("MESHY_API_KEY"), services, onProgress };
      const task = await waitForImageTo3D(o, await createImageTo3D(o, uri, polycount));
      if (!task.model_urls?.glb) throw new Error(`Meshy task ${task.id} has no GLB`);
      return downloadBytes(task.model_urls.glb);
    },
    blender: (input, output, settings) => runBlenderCleanup(input, output, settings, env.BLENDER ?? "blender"),
  };
}

/** No network, no spend: placeholder concept and box model. Blender still runs if available. */
export function dryRunClients(env = process.env): Clients {
  return {
    image: async () => PLACEHOLDER_PNG,
    meshy: async () => boxGlb(),
    blender: (input, output, settings) => runBlenderCleanup(input, output, settings, env.BLENDER ?? "blender"),
  };
}

export const CLEANUP_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../../tools/blender/cleanup.py");

/**
 * Runs Blender headless as a separate process. `blender` may be a Blender
 * binary (run with -b -P) or a Python interpreter that has the bpy module.
 */
export function runBlenderCleanup(input: string, output: string, settings: object, blender = "blender") {
  const settingsJson = JSON.stringify(settings);
  const isPython = /python[\d.]*$/.test(blender);
  const args = isPython
    ? [CLEANUP_SCRIPT, "--", input, output, settingsJson]
    : ["-b", "--factory-startup", "-P", CLEANUP_SCRIPT, "--", input, output, settingsJson];
  const out = execFileSync(blender, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  const line = out.split("\n").find((l) => l.startsWith("CLEANUP_RESULT "));
  if (!line) throw new Error(`Blender cleanup gave no result. Output:\n${out.slice(-2000)}`);
  return JSON.parse(line.slice("CLEANUP_RESULT ".length)) as { triangles: number; lods: number[]; height: number };
}

export interface ConceptOptions {
  kind: AssetKind;
  description?: string;
  /** Cost gate: concepts are cheap but still need a yes. */
  approved: boolean;
  /** Regenerate even if a matching asset exists. */
  force?: boolean;
  /** Bible tags (mood, area, character). */
  tags?: string[];
}

/** Blender cleanup settings for a model kind, taken from the bible. */
export function cleanupSettings(bible: Bible, kind: AssetKind) {
  return {
    targetHeight: TARGET_HEIGHT[kind],
    maxTriangles: polyBudgetFor(bible, kind),
    lodRatios: [1, 0.5, 0.25],
    palette: bible.visual.palette,
  };
}

function modelKind(asset: AssetRecord): AssetKind {
  if (!isModelKind(asset.kind)) throw new Error(`${asset.id} is a ${asset.kind} asset, not a 3D model`);
  return asset.kind;
}

export class AssetPipeline {
  constructor(
    readonly projectDir: string,
    readonly clients: Clients,
    readonly services: Services = defaultServices,
    readonly log: (msg: string) => void = () => {},
  ) {}

  private path(...p: string[]) {
    return join(this.projectDir, ...p);
  }

  private rel(abs: string) {
    return relative(this.projectDir, abs).split("\\").join("/");
  }

  private cost(e: Estimate): CostEntry {
    return { service: e.service, step: e.step, usd: e.usd, credits: e.credits, at: new Date().toISOString() };
  }

  /** Step 1: GPT concept using the Meshy-friendly template and approved concepts as style references. */
  async concept(subject: string, o: ConceptOptions): Promise<{ asset: AssetRecord; cached: boolean }> {
    const reg = loadRegistry(this.projectDir);
    const bible = loadBibleFrom(this.projectDir);
    const existing = reg.assets.find((a) => normalizeSubject(a.subject) === normalizeSubject(subject));
    if (existing && (existing.locked || (!o.force && existing.status !== "concept"))) {
      this.log(`Cache hit: "${subject}" is already ${existing.status} (${existing.id}).`);
      return { asset: existing, cached: true };
    }
    const est = gate(estimateConcept(this.services), o.approved);
    const prompt = buildAssetConceptPrompt(bible, subject, o.kind, o.description);
    const references = bible.visual.concepts
      .filter((c) => c.approved && existsSync(this.path(c.image)))
      .slice(-4)
      .map((c) => ({ name: c.image.split("/").pop()!, bytes: readFileSync(this.path(c.image)), mime: mimeOf(c.image) }));
    this.log(`Generating concept for "${subject}" (${references.length} style reference(s))...`);
    const png = await this.clients.image(prompt, references);

    const asset: AssetRecord = existing ?? {
      id: uniqueId(reg, subject),
      subject,
      kind: o.kind,
      description: o.description ?? "",
      status: "concept",
      source: "generated",
      locked: false,
      tags: o.tags ?? [],
      bibleVersion: bible.meta.version,
      costs: [],
    };
    const file = this.path("assets", "concepts", `${asset.id}.png`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, png);
    Object.assign(asset, { status: "concept", concept: this.rel(file), conceptPrompt: prompt, bibleVersion: bible.meta.version });
    asset.costs.push(this.cost(est));
    if (!existing) reg.assets.push(asset);
    saveRegistry(this.projectDir, reg);
    return { asset, cached: false };
  }

  /** Step 2: the user approves the concept. This locks the look and adds it to the bible as a style reference. */
  approve(id: string): AssetRecord {
    const reg = loadRegistry(this.projectDir);
    const asset = findAsset(reg, id);
    if (!asset.concept) throw new Error(`${id} has no concept image to approve`);
    if (asset.status === "concept") asset.status = "approved";
    const visualPath = this.path("bible", "visual.json");
    const visual = JSON.parse(readFileSync(visualPath, "utf8")) as Bible["visual"];
    if (!visual.concepts.some((c) => c.id === id)) {
      visual.concepts.push({ id, image: asset.concept, kind: "asset", subject: asset.subject, approved: true, bibleVersion: asset.bibleVersion });
      writeFileSync(visualPath, JSON.stringify(visual, null, 2) + "\n");
    }
    saveRegistry(this.projectDir, reg);
    return asset;
  }

  /** Step 3: Meshy image-to-3D from the approved concept image. Gated on cost. */
  async to3d(id: string, approved: boolean): Promise<AssetRecord> {
    const reg = loadRegistry(this.projectDir);
    const asset = findAsset(reg, id);
    if (asset.locked) throw new Error(`${id} is locked; it will not be regenerated`);
    if (STATUS_ORDER.indexOf(asset.status) < STATUS_ORDER.indexOf("approved") || !asset.concept)
      throw new Error(`${id} needs an approved concept first (status: ${asset.status}). Run: approve ${id}`);
    const est = gate(estimateMeshy(this.services), approved);
    const bible = loadBibleFrom(this.projectDir);
    const polycount = polyBudgetFor(bible, modelKind(asset));
    const uri = toDataUri(readFileSync(this.path(asset.concept)), mimeOf(asset.concept));
    this.log(`Sending concept ${asset.concept} to Meshy (target ${polycount} polys)...`);
    const glb = await this.clients.meshy(uri, polycount, (t) => this.log(`  Meshy ${t.status} ${t.progress ?? 0}%`));
    const file = this.path("assets", "models", "raw", `${id}.glb`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, glb);
    asset.rawModel = this.rel(file);
    asset.status = "3d";
    asset.costs.push(this.cost(est));
    saveRegistry(this.projectDir, reg);
    return asset;
  }

  /** Step 4: Blender headless cleanup: scale, pivot, decimate, palette materials, LODs, GLB. */
  cleanup(id: string): AssetRecord {
    const reg = loadRegistry(this.projectDir);
    const asset = findAsset(reg, id);
    if (!asset.rawModel) throw new Error(`${id} has no raw model yet. Run: to3d ${id}`);
    const bible = loadBibleFrom(this.projectDir);
    const out = this.path("assets", "models", `${id}.glb`);
    mkdirSync(dirname(out), { recursive: true });
    const settings = cleanupSettings(bible, modelKind(asset));
    this.log(`Cleaning ${asset.rawModel} in Blender...`);
    asset.stats = this.clients.blender(this.path(asset.rawModel), out, settings);
    asset.model = this.rel(out);
    asset.status = "cleaned";
    saveRegistry(this.projectDir, reg);
    return asset;
  }

  /**
   * Cheap bible update: re-runs only Blender cleanup (scale, budget, palette snap)
   * on the existing raw model with the current bible, and stamps the asset with
   * the current bible version. No API spend, so no gate. Refuses locked assets.
   */
  rematerial(id: string): AssetRecord {
    const reg = loadRegistry(this.projectDir);
    const asset = findAsset(reg, id);
    if (asset.locked) throw new Error(`${id} is locked; it will not be re-materialed`);
    if (!asset.rawModel || !existsSync(this.path(asset.rawModel)))
      throw new Error(`${id} has no raw model to re-material; use regenerate (paid) instead`);
    const bible = loadBibleFrom(this.projectDir);
    this.cleanup(id);
    const after = loadRegistry(this.projectDir);
    const updated = findAsset(after, id);
    updated.bibleVersion = bible.meta.version;
    saveRegistry(this.projectDir, after);
    return updated;
  }

  /**
   * Full redo against the current bible: new concept (GPT), auto-approved, Meshy
   * image-to-3D and Blender cleanup. One gate covers concept + Meshy. Refuses locked assets.
   */
  async regenerate(id: string, approved: boolean): Promise<AssetRecord> {
    const reg = loadRegistry(this.projectDir);
    const asset = findAsset(reg, id);
    if (asset.locked) throw new Error(`${id} is locked; it will not be regenerated`);
    const kind = modelKind(asset);
    gate(combineEstimates("regenerate", [estimateConcept(this.services), estimateMeshy(this.services)]), approved);
    await this.concept(asset.subject, { kind, description: asset.description, approved: true, force: true });
    this.approve(id);
    await this.to3d(id, true);
    return this.cleanup(id);
  }

  /** Runs every remaining step for one asset. Gates still apply to each paid step. */
  async run(subject: string, o: ConceptOptions & { approveConcept: boolean; approve3d: boolean }) {
    let { asset } = await this.concept(subject, o);
    if (asset.status === "concept" && o.approveConcept) asset = this.approve(asset.id);
    if (asset.status === "approved") asset = await this.to3d(asset.id, o.approve3d);
    if (asset.status === "3d") asset = this.cleanup(asset.id);
    return asset;
  }
}

/** Height in metres Blender scales each model kind to (also what asset QA checks against). */
export const TARGET_HEIGHT: Record<AssetKind, number> = { character: 1.8, creature: 1.2, prop: 0.8, environment: 2 };

export function mimeOf(path: string) {
  return /\.jpe?g$/i.test(path) ? "image/jpeg" : /\.webp$/i.test(path) ? "image/webp" : "image/png";
}
