// Asset QA: checks every finished asset in a project against the bible
// before anything is playtested.
//
// Models (cleaned GLBs): parsed from the GLB JSON chunk only. Bounds come from
// each POSITION accessor's min/max (required by the glTF spec), with the 8 box
// corners pushed through the node transforms (matrix or TRS, parents included).
// Flags: floating (lowest point not at y = 0, i.e. the pivot is not at the
// bottom), wrong scale (height more than 15% off the kind's target), over the
// bible poly budget (triangles from index/vertex counts, 5% tolerance for
// Blender's decimation), and untextured materials whose baseColorFactor is far
// from every bible palette color.
// Limits: skinning, morph targets and animation are ignored (rest pose), the
// bounds are an AABB of transformed accessor boxes (can be slightly loose for
// rotated nodes), and materials only count when a primitive references one.
//
// Audio: the OGG exists, is Ogg/Vorbis per ffprobe, has a duration > 0, and
// music loop points lie inside the track. Images and fonts: files exist.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadBibleFrom, TARGET_HEIGHT } from "../pipeline/assetPipeline";
import { polyBudgetFor } from "../pipeline/conceptPrompt";
import { mediaTools, probeAudio, type MediaTools } from "../pipeline/media";
import { isAudioKind, isModelKind, loadRegistry, type AssetRecord } from "../pipeline/registry";

export type AssetCheck = "missing-file" | "parse-error" | "floating" | "scale" | "poly-budget" | "off-palette" | "audio-format" | "audio-duration" | "loop-points";

export interface AssetIssue {
  assetId: string;
  check: AssetCheck;
  message: string;
  file?: string;
}

export const QA_LIMITS = {
  /** Allowed |min y| as a share of model height (with a 1 cm floor). */
  groundTolerance: 0.02,
  scaleTolerance: 0.15,
  polyBudgetTolerance: 0.05,
  /** Max sRGB (0-1) distance from the nearest palette color. */
  paletteDistance: 0.12,
};

// ---- GLB inspection ---------------------------------------------------------

type Mat4 = number[]; // column-major, like glTF

interface GltfNode {
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
}

interface Gltf {
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: GltfNode[];
  meshes?: { primitives: { attributes: Record<string, number>; indices?: number; material?: number; mode?: number }[] }[];
  accessors?: { count: number; min?: number[]; max?: number[] }[];
  materials?: { name?: string; pbrMetallicRoughness?: { baseColorFactor?: number[]; baseColorTexture?: unknown } }[];
}

export interface GlbInfo {
  min: [number, number, number];
  max: [number, number, number];
  height: number;
  triangles: number;
  /** Materials referenced by primitives. baseColor is linear RGB; textured ones are not palette-checked. */
  materials: { name: string; baseColor: [number, number, number]; textured: boolean }[];
}

/** Reads the JSON chunk of a GLB (or a plain .gltf JSON file). */
export function readGltfJson(bytes: Uint8Array): Gltf {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 20 && v.getUint32(0, true) === 0x46546c67) {
    const len = v.getUint32(12, true);
    if (v.getUint32(16, true) !== 0x4e4f534a) throw new Error("first GLB chunk is not JSON");
    return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len))) as Gltf;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as Gltf;
}

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mul(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!;
  return out;
}

function localMatrix(n: GltfNode): Mat4 {
  if (n.matrix?.length === 16) return n.matrix;
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  // R * S, column-major, then translation.
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

const apply = (m: Mat4, p: number[]) => [0, 1, 2].map((r) => m[r]! * p[0]! + m[4 + r]! * p[1]! + m[8 + r]! * p[2]! + m[12 + r]!);

/** Bounds (Y-up, metres), triangle count and referenced materials of a GLB. */
export function inspectGlb(bytes: Uint8Array): GlbInfo {
  const g = readGltfJson(bytes);
  const nodes = g.nodes ?? [];
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  let triangles = 0;
  const usedMaterials = new Set<number>();

  const childSet = new Set(nodes.flatMap((n) => n.children ?? []));
  const roots = g.scenes?.[g.scene ?? 0]?.nodes ?? nodes.map((_, i) => i).filter((i) => !childSet.has(i));
  const visit = (i: number, parent: Mat4, depth: number) => {
    const n = nodes[i];
    if (!n || depth > 64) return;
    const m = mul(parent, localMatrix(n));
    if (n.mesh !== undefined) {
      for (const p of g.meshes?.[n.mesh]?.primitives ?? []) {
        const pos = g.accessors?.[p.attributes.POSITION ?? -1];
        if (!pos) continue;
        if (!pos.min || !pos.max) throw new Error("POSITION accessor has no min/max");
        for (let c = 0; c < 8; c++) {
          const corner = [0, 1, 2].map((k) => ((c >> k) & 1 ? pos.max![k]! : pos.min![k]!));
          apply(m, corner).forEach((val, k) => {
            lo[k] = Math.min(lo[k]!, val);
            hi[k] = Math.max(hi[k]!, val);
          });
        }
        const count = p.indices !== undefined ? (g.accessors?.[p.indices]?.count ?? 0) : pos.count;
        const mode = p.mode ?? 4;
        triangles += mode === 4 ? Math.floor(count / 3) : mode === 5 || mode === 6 ? Math.max(0, count - 2) : 0;
        if (p.material !== undefined) usedMaterials.add(p.material);
      }
    }
    for (const c of n.children ?? []) visit(c, m, depth + 1);
  };
  for (const r of roots) visit(r, IDENTITY, 0);
  if (!Number.isFinite(lo[1]!)) throw new Error("no mesh geometry found");

  const materials = [...usedMaterials].map((i) => {
    const mat = g.materials?.[i];
    const f = mat?.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1];
    return {
      name: mat?.name ?? `material ${i}`,
      baseColor: [f[0] ?? 1, f[1] ?? 1, f[2] ?? 1] as [number, number, number],
      textured: !!mat?.pbrMetallicRoughness?.baseColorTexture,
    };
  });
  return {
    min: lo as [number, number, number],
    max: hi as [number, number, number],
    height: hi[1]! - lo[1]!,
    triangles,
    materials,
  };
}

const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const hexToSrgb = (h: string) => [0, 2, 4].map((i) => Number.parseInt(h.replace("#", "").slice(i, i + 2), 16) / 255);

/** Nearest palette color to a linear RGB color, with its sRGB distance. */
export function nearestPaletteColor(linear: [number, number, number], palette: Record<string, string>) {
  const srgb = linear.map((c) => linearToSrgb(Math.min(1, Math.max(0, c))));
  let best = { name: "", hex: "", distance: Infinity };
  for (const [name, hex] of Object.entries(palette)) {
    const d = Math.hypot(...hexToSrgb(hex).map((c, i) => c - srgb[i]!));
    if (d < best.distance) best = { name, hex, distance: d };
  }
  return best;
}

// ---- project check ----------------------------------------------------------

/**
 * QA for every finished asset in a project: cleaned GLBs (floating, scale,
 * poly budget, off-palette), audio (OGG exists, Vorbis, duration > 0, loop
 * points) and image/font files. Returns the issues found (empty = all good).
 */
export function checkProjectAssets(projectDir: string, tools: MediaTools = mediaTools()): { checked: number; issues: AssetIssue[] } {
  const bible = loadBibleFrom(projectDir);
  const issues: AssetIssue[] = [];
  let checked = 0;
  const abs = (p: string) => join(projectDir, p);

  for (const a of loadRegistry(projectDir).assets) {
    const add = (check: AssetCheck, message: string, file?: string) => issues.push({ assetId: a.id, check, message, ...(file ? { file } : {}) });
    if (isModelKind(a.kind) && a.model) {
      checked++;
      if (!existsSync(abs(a.model))) {
        add("missing-file", `model file ${a.model} is missing`, a.model);
        continue;
      }
      checkModel(a, readFileSync(abs(a.model)), bible.visual.palette, polyBudgetFor(bible, a.kind), add);
    } else if (isAudioKind(a.kind) && a.status === "cleaned") {
      checked++;
      checkAudio(a, abs, tools, add);
    } else if (a.files && (a.kind === "texture" || a.kind === "image" || a.kind === "reference" || a.kind === "font")) {
      checked++;
      for (const [role, f] of Object.entries(a.files)) if (!existsSync(abs(f))) add("missing-file", `${role} file ${f} is missing`, f);
    }
  }
  return { checked, issues };
}

function checkModel(
  a: AssetRecord,
  bytes: Uint8Array,
  palette: Record<string, string>,
  budget: number,
  add: (check: AssetCheck, message: string, file?: string) => void,
) {
  let info: GlbInfo;
  try {
    info = inspectGlb(bytes);
  } catch (e) {
    add("parse-error", `could not read ${a.model}: ${(e as Error).message}`, a.model);
    return;
  }
  const f = (n: number) => n.toFixed(2);
  if (Math.abs(info.min[1]) > Math.max(0.01, QA_LIMITS.groundTolerance * info.height))
    add("floating", `lowest point is at y=${f(info.min[1])} (pivot should be at the bottom, y=0)`, a.model);
  const target = isModelKind(a.kind) ? TARGET_HEIGHT[a.kind] : undefined;
  if (target && Math.abs(info.height - target) / target > QA_LIMITS.scaleTolerance)
    add("scale", `height ${f(info.height)} m vs target ${f(target)} m for a ${a.kind} (more than ${QA_LIMITS.scaleTolerance * 100}% off)`, a.model);
  if (info.triangles > budget * (1 + QA_LIMITS.polyBudgetTolerance))
    add("poly-budget", `${info.triangles} triangles is over the ${a.kind} budget of ${budget}`, a.model);
  for (const m of info.materials) {
    if (m.textured) continue;
    const near = nearestPaletteColor(m.baseColor, palette);
    if (near.distance > QA_LIMITS.paletteDistance)
      add("off-palette", `material "${m.name}" base color is far from every palette color (nearest ${near.name} ${near.hex}, distance ${f(near.distance)})`, a.model);
  }
}

function checkAudio(a: AssetRecord, abs: (p: string) => string, tools: MediaTools, add: (check: AssetCheck, message: string, file?: string) => void) {
  if (!a.audio?.file) return add("missing-file", "no processed OGG recorded");
  if (!existsSync(abs(a.audio.file))) return add("missing-file", `audio file ${a.audio.file} is missing`, a.audio.file);
  let p: ReturnType<typeof probeAudio>;
  try {
    p = probeAudio(abs(a.audio.file), tools);
  } catch (e) {
    return add("parse-error", `ffprobe could not read ${a.audio.file}: ${(e as Error).message}`, a.audio.file);
  }
  if (!p.format.split(",").includes("ogg") || p.codec !== "vorbis")
    add("audio-format", `${a.audio.file} is ${p.format}/${p.codec}, expected ogg/vorbis`, a.audio.file);
  if (!(p.duration > 0)) add("audio-duration", `${a.audio.file} has no duration`, a.audio.file);
  if (a.kind === "music") {
    const { loopStart = 0, loopEnd = p.duration } = a.audio;
    if (loopStart < 0 || loopEnd <= loopStart || loopEnd > p.duration + 0.05)
      add("loop-points", `loop ${loopStart}-${loopEnd}s does not fit the ${p.duration.toFixed(2)}s track`, a.audio.file);
  }
}
