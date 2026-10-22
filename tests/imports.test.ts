import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bible } from "../projects/dungeon-crawler/index";
import type { BibleMeta, VisualLayer } from "../src/bible/types";
import { AssetPipeline, dryRunClients, TARGET_HEIGHT, type Clients } from "../src/pipeline/assetPipeline";
import { bumpBibleVersion, rematerial, staleAssets } from "../src/pipeline/bibleVersion";
import { ApprovalRequired, estimateConcept, estimateMeshy } from "../src/pipeline/gates";
import { importAsset, type ImportOptions } from "../src/pipeline/imports";
import { probeAudio, probeImage, sineWav } from "../src/pipeline/media";
import { boxGlb, PLACEHOLDER_PNG } from "../src/pipeline/placeholderGlb";
import { loadRegistry } from "../src/pipeline/registry";
import { checkProjectAssets } from "../src/qa/assets";
import { editBible, readJson, tmpProject } from "./helpers";

const scratch = () => mkdtempSync(join(tmpdir(), "gc-src-"));
const license: Pick<ImportOptions, "origin" | "license"> = { origin: "purchased-pack", license: "Crypt Sounds Vol.1, single-game commercial license" };

function wav(seconds: number) {
  const f = join(scratch(), "track.wav");
  sineWav(f, seconds, 330);
  return f;
}

function image(w: number, h: number, ext = "png") {
  const f = join(scratch(), `pic.${ext}`);
  execFileSync("ffmpeg", ["-hide_banner", "-y", "-f", "lavfi", "-i", `color=c=0x9c2a2a:s=${w}x${h}`, "-frames:v", "1", f], { stdio: "ignore" });
  return f;
}

/** Fake Blender: records calls and writes a clean box GLB at the target height. */
function fakeBlender() {
  const calls: { input: string; output: string; settings: { targetHeight: number; palette: Record<string, string> } }[] = [];
  const blender: Clients["blender"] = (input, output, settings) => {
    const s = settings as (typeof calls)[number]["settings"];
    calls.push({ input, output, settings: s });
    writeFileSync(output, boxGlb(0.5, s.targetHeight, 0.5));
    return { triangles: 12, lods: [12, 6, 3], height: s.targetHeight };
  };
  return { blender, calls };
}

describe("import validation", () => {
  it("refuses imports without source and license, before writing anything", () => {
    const dir = tmpProject();
    const f = wav(1);
    expect(() => importAsset(dir, f, { origin: "purchased-pack", license: "" })).toThrow(/license terms are required/);
    expect(() => importAsset(dir, f, { origin: "", license: "CC0" })).toThrow(/source is required/);
    expect(() => importAsset(dir, f, { origin: "found-it-online", license: "CC0" })).toThrow(/must be one of/);
    expect(() => importAsset(dir, join(dir, "nope.wav"), license)).toThrow(/No such file/);
    expect(() => importAsset(dir, f, { ...license, as: "model" })).toThrow(/model import must be one of/);
    expect(existsSync(join(dir, "assets"))).toBe(false);
    expect(loadRegistry(dir).assets).toHaveLength(0);
  });
});

describe("audio imports", () => {
  it("normalizes to OGG, infers sfx vs music, keeps the license, tags and locks", () => {
    const dir = tmpProject();
    const sfx = importAsset(dir, wav(2), { ...license, tags: ["tavern ambience"], subject: "mug clink" });
    expect(sfx).toMatchObject({ id: "mug-clink", kind: "sfx", source: "imported", locked: true, status: "cleaned" });
    expect(sfx.license).toEqual({ origin: "purchased-pack", terms: license.license });
    expect(sfx.tags).toEqual(["sfx", "tavern ambience"]);
    expect(probeAudio(join(dir, sfx.audio!.file)).codec).toBe("vorbis");
    expect(existsSync(join(dir, sfx.files!.original!))).toBe(true);

    const music = importAsset(dir, wav(31), { origin: "commissioned", license: "work for hire", tags: ["boss battle"] });
    expect(music.kind).toBe("music");
    expect(music.audio!.loopStart).toBe(0);
    expect(music.audio!.loopEnd).toBeCloseTo(31, 0);

    const looped = importAsset(dir, wav(3), { ...license, as: "music", loopStart: 0.5, loopEnd: 2.5 });
    expect([looped.audio!.loopStart, looped.audio!.loopEnd]).toEqual([0.5, 2.5]);
    expect(checkProjectAssets(dir).issues).toEqual([]);
  }, 30_000);
});

describe("image, reference and font imports", () => {
  it("resizes textures to the bible budget and writes a 256px thumbnail and 64px icon", () => {
    const dir = tmpProject();
    const a = importAsset(dir, image(2048, 1024), { ...license, origin: "royalty-free", license: "CC0 (ambientcg.com)", subject: "crypt bricks" });
    expect(a.kind).toBe("texture");
    expect(a.files!.image).toBe("assets/textures/crypt-bricks.png");
    const max = bible.visual.textureResolution;
    expect(probeImage(join(dir, a.files!.image!))).toEqual({ width: max, height: max / 2 });
    expect(probeImage(join(dir, a.files!.thumbnail!))).toEqual({ width: 256, height: 128 });
    expect(probeImage(join(dir, a.files!.icon!))).toEqual({ width: 64, height: 64 });

    // Small images are never upscaled; jpg stays jpg.
    const small = importAsset(dir, image(300, 200, "jpg"), { ...license, as: "image" });
    expect(small.files!.image).toMatch(/^assets\/images\/.+\.jpg$/);
    expect(probeImage(join(dir, small.files!.image!))).toEqual({ width: 300, height: 200 });
  }, 30_000);

  it("puts reference images into the bible as user-reference style references", async () => {
    const dir = tmpProject();
    const a = importAsset(dir, image(800, 600), { origin: "in-house", license: "our own sketch", as: "reference", subject: "warden sketch", tags: ["warden"] });
    expect(a.kind).toBe("reference");
    expect(a.files!.image).toBe("bible/concepts/warden-sketch.png");
    const visual = readJson<VisualLayer>(join(dir, "bible", "visual.json"));
    expect(visual.concepts).toEqual([
      { id: "warden-sketch", image: "bible/concepts/warden-sketch.png", kind: "user-reference", subject: "warden sketch", approved: true, bibleVersion: 1 },
    ]);
    // ...and GPT concepts now get it as a style reference.
    const refs: string[] = [];
    const clients: Clients = { ...dryRunClients(), image: async (_p, r) => (refs.push(...r.map((x) => x.name)), PLACEHOLDER_PNG) };
    await new AssetPipeline(dir, clients).concept("warden", { kind: "character", approved: true });
    expect(refs).toEqual(["warden-sketch.png"]);
  }, 30_000);

  it("copies and registers fonts, and rejects files that are not fonts", () => {
    const dir = tmpProject();
    const ttf = join(scratch(), "Crypt Gothic.ttf");
    writeFileSync(ttf, Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.alloc(60)]));
    const a = importAsset(dir, ttf, { origin: "purchased-pack", license: "Desktop + web embedding" });
    expect(a).toMatchObject({ id: "crypt-gothic", kind: "font", locked: true });
    expect(readFileSync(join(dir, a.files!.font!))).toEqual(readFileSync(ttf));
    const fake = join(scratch(), "fake.otf");
    writeFileSync(fake, "not a font");
    expect(() => importAsset(dir, fake, license)).toThrow(/does not look like/);
  });
});

describe("model imports", () => {
  it("runs the same Blender cleanup as Meshy output and is never regenerated", async () => {
    const dir = tmpProject();
    const src = join(scratch(), "goblin_king.glb");
    writeFileSync(src, boxGlb(1, 5, 1, { offset: [2, 3, 0] }));
    const { blender, calls } = fakeBlender();
    const a = importAsset(dir, src, { origin: "commissioned", license: "exclusive", modelKind: "character", tags: ["boss"], blender });
    expect(a).toMatchObject({ id: "goblin-king", kind: "character", locked: true, source: "imported", model: "assets/models/goblin-king.glb" });
    expect(a.rawModel).toBe("assets/imports/goblin-king/goblin_king.glb");
    expect(calls[0]!.input).toBe(join(dir, a.rawModel!));
    expect(calls[0]!.settings).toMatchObject({ targetHeight: TARGET_HEIGHT.character, maxTriangles: bible.visual.polyBudgets.character });

    const p = new AssetPipeline(dir, { ...dryRunClients(), blender });
    await expect(p.to3d(a.id, true)).rejects.toThrow(/locked/);
    await expect(p.regenerate(a.id, true)).rejects.toThrow(/locked/);
    expect(() => p.rematerial(a.id)).toThrow(/locked/);
    const cached = await p.concept("goblin king", { kind: "character", approved: true, force: true });
    expect(cached.cached).toBe(true);
  });
});

describe("bible versioning", () => {
  async function generatedModel(dir: string, blender: Clients["blender"]) {
    const p = new AssetPipeline(dir, { ...dryRunClients(), blender });
    return { p, asset: await p.run("crypt rat", { kind: "creature", approved: true, approveConcept: true, approve3d: true }) };
  }

  it("bumps the version, lists stale non-locked assets, and re-materials them cheaply", async () => {
    const dir = tmpProject();
    const { blender, calls } = fakeBlender();
    const { asset } = await generatedModel(dir, blender);
    importAsset(dir, wav(1), license); // locked: never listed as stale
    expect(staleAssets(dir).stale).toEqual([]);

    editBible<VisualLayer>(dir, "visual", (v) => {
      v.palette.moss = "#4f8a3a";
    });
    expect(bumpBibleVersion(dir)).toBe(2);
    expect(readJson<BibleMeta>(join(dir, "bible", "meta.json")).version).toBe(2);
    expect(staleAssets(dir)).toEqual({ bibleVersion: 2, stale: [{ id: asset.id, kind: "creature", bibleVersion: 1, action: "rematerial" }] });

    const before = calls.length;
    const spentBefore = loadRegistry(dir).assets[0]!.costs.length;
    const r = rematerial(dir, asset.id, { ...dryRunClients(), blender });
    expect(r.bibleVersion).toBe(2);
    expect(calls).toHaveLength(before + 1);
    expect(calls.at(-1)!.input).toBe(join(dir, asset.rawModel!));
    expect(calls.at(-1)!.settings.palette.moss).toBe("#4f8a3a");
    expect(loadRegistry(dir).assets[0]!.costs).toHaveLength(spentBefore); // no spend
    expect(staleAssets(dir).stale).toEqual([]);
  });

  it("regenerate redoes concept + 3D behind one gate with a combined estimate", async () => {
    const dir = tmpProject();
    const { blender } = fakeBlender();
    const { p, asset } = await generatedModel(dir, blender);
    bumpBibleVersion(dir);
    const err = (await p.regenerate(asset.id, false).catch((e) => e)) as ApprovalRequired;
    expect(err).toBeInstanceOf(ApprovalRequired);
    expect(err.estimate.usd).toBeCloseTo(estimateConcept().usd + estimateMeshy().usd, 6);
    const r = await p.regenerate(asset.id, true);
    expect(r.bibleVersion).toBe(2);
    expect(r.status).toBe("cleaned");
    expect(r.costs.map((c) => c.service)).toEqual(["openai", "meshy", "openai", "meshy"]);
  });
});

const BLENDER = process.env.BLENDER;
describe.skipIf(!BLENDER)("model imports through real Blender (needs BLENDER)", () => {
  const exportFrom = (ext: "obj" | "fbx") => {
    const f = join(scratch(), `lantern.${ext}`);
    const op = ext === "obj" ? `bpy.ops.wm.obj_export(filepath=${JSON.stringify(f)})` : `bpy.ops.export_scene.fbx(filepath=${JSON.stringify(f)})`;
    const make = `import bpy\nbpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=2, depth=6, location=(5,1,7))\n${op}`;
    const isPy = /python[\d.]*$/.test(BLENDER!);
    execFileSync(BLENDER!, isPy ? ["-c", make] : ["-b", "--factory-startup", "--python-expr", make], { stdio: "ignore" });
    return f;
  };

  for (const ext of ["obj", "fbx"] as const) {
    it(`cleans an imported .${ext} into a GLB that passes asset QA`, () => {
      const dir = tmpProject();
      const a = importAsset(dir, exportFrom(ext), { origin: "in-house", license: "ours", modelKind: "prop", env: { ...process.env } });
      expect(a.model).toBe(`assets/models/lantern.glb`);
      expect(a.stats!.height).toBeCloseTo(TARGET_HEIGHT.prop, 2);
      expect(checkProjectAssets(dir).issues).toEqual([]);
    }, 60_000);
  }
});
