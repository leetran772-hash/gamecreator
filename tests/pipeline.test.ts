import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bible } from "../projects/dungeon-crawler/index";
import { AssetPipeline, dryRunClients, runBlenderCleanup, type Clients } from "../src/pipeline/assetPipeline";
import { buildAssetConceptPrompt, buildMoodPrompt, MESHY_FRIENDLY_RULES, polyBudgetFor } from "../src/pipeline/conceptPrompt";
import { ApprovalRequired } from "../src/pipeline/gates";
import { createImageTo3D, toDataUri, waitForImageTo3D } from "../src/pipeline/meshy";
import { generateImage } from "../src/pipeline/openaiImages";
import { PLACEHOLDER_PNG } from "../src/pipeline/placeholderGlb";
import { loadRegistry } from "../src/pipeline/registry";

const tmpProject = () => {
  const dir = mkdtempSync(join(tmpdir(), "gc-"));
  cpSync("projects/dungeon-crawler/bible", join(dir, "bible"), { recursive: true });
  return dir;
};

type Call = { url: string; init?: RequestInit };
const mockFetch = (responses: unknown[]) => {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
};

describe("concept prompts", () => {
  it("asset concepts follow the Meshy-friendly template and the bible", () => {
    const p = buildAssetConceptPrompt(bible, "a crypt rat", "creature");
    for (const rule of MESHY_FRIENDLY_RULES) expect(p).toContain(rule);
    expect(p).toContain(bible.visual.palette.ember);
    expect(p).toContain(bible.meta.style);
    expect(buildAssetConceptPrompt(bible, "hero", "character")).toContain("A-pose");
    expect(buildMoodPrompt(bible, "the crypt gate")).not.toContain(MESHY_FRIENDLY_RULES[0]);
    expect(polyBudgetFor(bible, "prop")).toBe(bible.visual.polyBudgets.prop);
  });
});

describe("OpenAI images", () => {
  it("uses generations without references and edits with references", async () => {
    const b64 = Buffer.from(PLACEHOLDER_PNG).toString("base64");
    const { f, calls } = mockFetch([{ data: [{ b64_json: b64 }] }, { data: [{ b64_json: b64 }] }]);
    const img = await generateImage({ prompt: "p", apiKey: "k", fetch: f });
    expect(Buffer.from(img).equals(Buffer.from(PLACEHOLDER_PNG))).toBe(true);
    expect(calls[0]!.url).toMatch(/\/images\/generations$/);
    expect(JSON.parse(String(calls[0]!.init!.body)).model).toBeTruthy();
    await generateImage({ prompt: "p", apiKey: "k", fetch: f, references: [{ name: "a.png", bytes: PLACEHOLDER_PNG, mime: "image/png" }] });
    expect(calls[1]!.url).toMatch(/\/images\/edits$/);
    expect((calls[1]!.init!.body as FormData).getAll("image[]").length).toBe(1);
  });
});

describe("Meshy", () => {
  it("sends the concept image as a data URI with the poly budget, then polls", async () => {
    const { f, calls } = mockFetch([
      { result: "task-1" },
      { id: "task-1", status: "IN_PROGRESS", progress: 40 },
      { id: "task-1", status: "SUCCEEDED", progress: 100, model_urls: { glb: "https://x/m.glb" } },
    ]);
    const o = { apiKey: "k", fetch: f, sleep: async () => {} };
    const uri = toDataUri(PLACEHOLDER_PNG);
    const id = await createImageTo3D(o, uri, 8000);
    expect(id).toBe("task-1");
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.image_url).toBe(uri);
    expect(body.image_url.startsWith("data:image/png;base64,")).toBe(true);
    expect(body.target_polycount).toBe(8000);
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer k");
    const task = await waitForImageTo3D(o, id);
    expect(task.model_urls?.glb).toBe("https://x/m.glb");
    expect(calls[2]!.url).toMatch(/\/image-to-3d\/task-1$/);
  });

  it("surfaces failed tasks", async () => {
    const { f } = mockFetch([{ id: "t", status: "FAILED", task_error: { message: "bad image" } }]);
    await expect(waitForImageTo3D({ apiKey: "k", fetch: f, sleep: async () => {} }, "t")).rejects.toThrow("bad image");
  });
});

describe("asset pipeline", () => {
  const fakeClients = (): Clients & { meshyInputs: string[] } => {
    const meshyInputs: string[] = [];
    const dry = dryRunClients();
    return {
      meshyInputs,
      image: dry.image,
      meshy: async (uri, poly) => {
        meshyInputs.push(`${poly}:${uri}`);
        return dry.meshy(uri, poly);
      },
      blender: () => ({ triangles: 12, lods: [12, 6, 3], height: 1.2 }),
    };
  };

  it("gates spend, requires concept approval, and feeds the approved concept to Meshy", async () => {
    const dir = tmpProject();
    const clients = fakeClients();
    const p = new AssetPipeline(dir, clients);
    await expect(p.concept("crypt rat", { kind: "creature", approved: false })).rejects.toBeInstanceOf(ApprovalRequired);
    const { asset } = await p.concept("crypt rat", { kind: "creature", approved: true });
    await expect(p.to3d(asset.id, true)).rejects.toThrow(/approved concept/);
    p.approve(asset.id);
    await expect(p.to3d(asset.id, false)).rejects.toBeInstanceOf(ApprovalRequired);
    await p.to3d(asset.id, true);
    const concept = readFileSync(join(dir, "assets/concepts/crypt-rat.png"));
    expect(clients.meshyInputs).toEqual([`${bible.visual.polyBudgets.character}:${toDataUri(concept)}`]);
    p.cleanup(asset.id);
    const rec = loadRegistry(dir).assets[0]!;
    expect(rec.status).toBe("cleaned");
    expect(rec.costs.map((c) => c.service)).toEqual(["openai", "meshy"]);
  });

  it("reuses existing assets (cache) and passes approved concepts as style references", async () => {
    const dir = tmpProject();
    const refs: number[] = [];
    const clients = { ...fakeClients(), image: async (_: string, r: unknown[]) => (refs.push(r.length), PLACEHOLDER_PNG) };
    const p = new AssetPipeline(dir, clients);
    await p.concept("wooden crate", { kind: "prop", approved: true });
    p.approve("wooden-crate");
    const again = await p.concept("Wooden  Crate", { kind: "prop", approved: true });
    expect(again.cached).toBe(true);
    await p.concept("iron chest", { kind: "prop", approved: true });
    expect(refs).toEqual([0, 1]);
  });
});

const BLENDER = process.env.BLENDER;
describe.skipIf(!BLENDER)("blender cleanup (needs BLENDER=path to blender or a python with bpy)", () => {
  it("normalizes scale and pivot, decimates to budget and writes LODs", () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-blend-"));
    const raw = join(dir, "raw.glb");
    // A heavy, off-centre, oversized sphere, like an unprocessed generated model.
    const make = `import bpy\nbpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.ops.mesh.primitive_uv_sphere_add(segments=128, ring_count=64, radius=7, location=(3,4,9))\nbpy.ops.export_scene.gltf(filepath=${JSON.stringify(raw)}, export_format="GLB")`;
    const isPy = /python[\d.]*$/.test(BLENDER!);
    execFileSync(BLENDER!, isPy ? ["-c", make] : ["-b", "--factory-startup", "--python-expr", make], { stdio: "ignore" });
    const out = join(dir, "clean.glb");
    const r = runBlenderCleanup(raw, out, { targetHeight: 1.8, maxTriangles: 2000, lodRatios: [1, 0.5, 0.25], palette: bible.visual.palette }, BLENDER);
    expect(r.height).toBeCloseTo(1.8, 1);
    expect(r.triangles).toBeLessThanOrEqual(2100);
    expect(r.lods[1]!).toBeLessThan(r.lods[0]!);
    expect(existsSync(join(dir, "clean.lod2.glb"))).toBe(true);
  }, 60_000);
});
