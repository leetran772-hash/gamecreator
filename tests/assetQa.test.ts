import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bible } from "../projects/dungeon-crawler/index";
import { AssetPipeline, dryRunClients, TARGET_HEIGHT } from "../src/pipeline/assetPipeline";
import { AudioPipeline, dryRunAudioClients } from "../src/pipeline/audioPipeline";
import type { AssetKind } from "../src/pipeline/conceptPrompt";
import { boxGlb, type BoxOptions } from "../src/pipeline/placeholderGlb";
import { loadRegistry, saveRegistry, type AssetRecord } from "../src/pipeline/registry";
import { checkProjectAssets, inspectGlb, nearestPaletteColor } from "../src/qa/assets";
import { tmpProject } from "./helpers";

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const hexLinear = (hex: string) => [0, 2, 4].map((i) => srgbToLinear(Number.parseInt(hex.slice(1 + i, 3 + i), 16) / 255)) as [number, number, number];

/** A GLB with only a JSON chunk: enough for QA, which reads accessor min/max and counts. */
function jsonOnlyGlb(gltf: object): Uint8Array {
  let json = new TextEncoder().encode(JSON.stringify(gltf));
  const pad = (4 - (json.length % 4)) % 4;
  if (pad) json = new Uint8Array([...json, ...new Array(pad).fill(0x20)]);
  const out = new Uint8Array(20 + json.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, out.length, true);
  v.setUint32(12, json.length, true);
  v.setUint32(16, 0x4e4f534a, true);
  out.set(json, 20);
  return out;
}

function addModel(dir: string, id: string, kind: AssetKind, glb: Uint8Array) {
  const reg = loadRegistry(dir);
  const rel = `assets/models/${id}.glb`;
  mkdirSync(join(dir, "assets", "models"), { recursive: true });
  writeFileSync(join(dir, rel), glb);
  const rec: AssetRecord = { id, subject: id, kind, description: "", status: "cleaned", source: "generated", locked: false, tags: [], bibleVersion: 1, model: rel, costs: [] };
  reg.assets.push(rec);
  saveRegistry(dir, reg);
}

const prop = (o: BoxOptions = {}, h = TARGET_HEIGHT.prop) => boxGlb(0.5, h, 0.5, o);
const checksFor = (dir: string, id: string) => checkProjectAssets(dir).issues.filter((i) => i.assetId === id).map((i) => i.check);

describe("GLB inspection", () => {
  it("reads bounds, triangles and materials, applying node transforms", () => {
    const info = inspectGlb(boxGlb(1, 2, 1, { translation: [0, 1, 0], scale: [2, 0.5, 2], baseColor: [1, 0, 0, 1] }));
    expect(info.min[1]).toBeCloseTo(1);
    expect(info.height).toBeCloseTo(1);
    expect(info.max[0]).toBeCloseTo(1);
    expect(info.triangles).toBe(12);
    expect(info.materials).toEqual([{ name: "base", baseColor: [1, 0, 0], textured: false }]);
    expect(nearestPaletteColor(hexLinear(bible.visual.palette.ember!), bible.visual.palette)).toMatchObject({ name: "ember" });
  });

  it("handles nested nodes and matrices", () => {
    const base = inspectGlb(boxGlb(1, 1, 1));
    expect(base.min[1]).toBeCloseTo(0);
    const g = {
      asset: { version: "2.0" },
      scenes: [{ nodes: [0] }],
      nodes: [{ children: [1], matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 2, 0, 1] }, { mesh: 0, translation: [0, 1, 0] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ count: 9, min: [-1, 0, -1], max: [1, 1, 1] }],
    };
    const info = inspectGlb(jsonOnlyGlb(g));
    expect(info.min[1]).toBeCloseTo(3);
    expect(info.triangles).toBe(3); // non-indexed: 9 vertices = 3 triangles
  });
});

describe("asset QA: models", () => {
  it("passes a grounded, right-sized, on-palette model", () => {
    const dir = tmpProject();
    addModel(dir, "crate", "prop", prop({ baseColor: [...hexLinear(bible.visual.palette.stone!), 1] }));
    expect(checkProjectAssets(dir)).toEqual({ checked: 1, issues: [] });
  });

  it("flags floating, oversized and off-palette models", () => {
    const dir = tmpProject();
    addModel(dir, "floater", "prop", prop({ offset: [0, 0.4, 0] }));
    addModel(dir, "lifted-node", "prop", prop({ translation: [0, 0.3, 0] }));
    addModel(dir, "giant", "creature", boxGlb(1, TARGET_HEIGHT.creature * 2.5, 1));
    addModel(dir, "stretched", "character", boxGlb(1, TARGET_HEIGHT.character, 1, { scale: [1, 1.5, 1] }));
    addModel(dir, "slightly-big", "character", boxGlb(1, TARGET_HEIGHT.character * 1.1, 1));
    addModel(dir, "neon", "prop", prop({ baseColor: [0, 1, 0, 1] }));
    expect(checksFor(dir, "floater")).toEqual(["floating"]);
    expect(checksFor(dir, "lifted-node")).toEqual(["floating"]);
    expect(checksFor(dir, "giant")).toEqual(["scale"]);
    expect(checksFor(dir, "stretched")).toEqual(["scale"]);
    expect(checksFor(dir, "slightly-big")).toEqual([]); // within 15%
    expect(checksFor(dir, "neon")).toEqual(["off-palette"]);
    const neon = checkProjectAssets(dir).issues.find((i) => i.assetId === "neon")!;
    expect(neon.message).toMatch(/nearest moss/);
  });

  it("flags models over the bible poly budget, and textured materials are not palette-checked", () => {
    const dir = tmpProject();
    const budget = bible.visual.polyBudgets.prop;
    const heavy = (tris: number, textured = false) =>
      jsonOnlyGlb({
        asset: { version: "2.0" },
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
        materials: [{ name: "skin", pbrMetallicRoughness: { baseColorFactor: [1, 0, 1, 1], ...(textured ? { baseColorTexture: { index: 0 } } : {}) } }],
        accessors: [
          { count: 100, min: [-0.2, 0, -0.2], max: [0.2, TARGET_HEIGHT.prop, 0.2] },
          { count: tris * 3 },
        ],
      });
    addModel(dir, "heavy", "prop", heavy(budget * 2, true));
    addModel(dir, "ok", "prop", heavy(budget, true));
    addModel(dir, "magenta", "prop", heavy(10));
    expect(checksFor(dir, "heavy")).toEqual(["poly-budget"]);
    expect(checksFor(dir, "ok")).toEqual([]);
    expect(checksFor(dir, "magenta")).toEqual(["off-palette"]);
  });

  it("reports missing and unreadable model files", () => {
    const dir = tmpProject();
    addModel(dir, "gone", "prop", prop());
    addModel(dir, "junk", "prop", new TextEncoder().encode("not a glb"));
    rmSync(join(dir, "assets/models/gone.glb"));
    expect(checksFor(dir, "gone")).toEqual(["missing-file"]);
    expect(checksFor(dir, "junk")).toEqual(["parse-error"]);
  });
});

describe("asset QA: audio", () => {
  it("accepts processed OGGs and flags missing, non-OGG or badly looped audio", async () => {
    const dir = tmpProject();
    const p = new AudioPipeline(dir, dryRunAudioClients());
    const sfx = (await p.sfx("door creak", { approved: true, durationSeconds: 1 })).asset;
    const music = (await p.music("explore", { approved: true, seconds: 4 })).asset;
    const gone = (await p.sfx("drip", { approved: true, durationSeconds: 1 })).asset;
    expect(checkProjectAssets(dir)).toEqual({ checked: 3, issues: [] });

    rmSync(join(dir, gone.audio!.file));
    copyFileSync(join(dir, sfx.files!.raw!), join(dir, sfx.audio!.file)); // a WAV posing as .ogg
    const reg = loadRegistry(dir);
    reg.assets.find((a) => a.id === music.id)!.audio!.loopEnd = 99;
    saveRegistry(dir, reg);
    expect(checksFor(dir, gone.id)).toEqual(["missing-file"]);
    expect(checksFor(dir, sfx.id)).toEqual(["audio-format"]);
    expect(checksFor(dir, music.id)).toEqual(["loop-points"]);
  }, 30_000);
});

const BLENDER = process.env.BLENDER;
describe.skipIf(!BLENDER)("asset QA on real Blender output (needs BLENDER)", () => {
  it("a dry-run concept -> 3D -> cleanup model passes QA; a raw floating model would not", async () => {
    const dir = tmpProject();
    const p = new AssetPipeline(dir, dryRunClients({ ...process.env }));
    // Raw dry-run box is 1.8 m tall: as a prop it must be rescaled by Blender.
    const a = await p.run("wooden crate", { kind: "prop", approved: true, approveConcept: true, approve3d: true });
    expect(a.status).toBe("cleaned");
    expect(checkProjectAssets(dir).issues).toEqual([]);
    addModel(dir, "raw", "prop", boxGlb(1, 1.8, 0.6, { offset: [0, 0.5, 0] }));
    expect(checksFor(dir, "raw").sort()).toEqual(["floating", "scale"]);
  }, 60_000);
});
