// External imports: music, SFX, 3D models, textures/images, fonts and reference
// images from outside the studio. Source and license are required. Imports end
// in the same state as generated assets (cleaned, bible-tagged, GLB or OGG) and
// are locked: the agent never regenerates them.
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import type { Bible } from "../bible/types";
import { cleanupSettings, loadBibleFrom, runBlenderCleanup, type Clients } from "./assetPipeline";
import { finishAudioAsset } from "./audioPipeline";
import type { AssetKind } from "./conceptPrompt";
import { mediaTools, probeDuration, resizeImage, squareIcon, type MediaTools } from "./media";
import {
  isModelKind,
  LICENSE_ORIGINS,
  loadRegistry,
  saveRegistry,
  uniqueId,
  type AssetRecord,
  type LicenseOrigin,
} from "./registry";

export type ImportAs = "music" | "sfx" | "model" | "texture" | "image" | "font" | "reference";
export const IMPORT_TYPES: readonly ImportAs[] = ["music", "sfx", "model", "texture", "image", "font", "reference"];

export const AUDIO_EXTS = [".ogg", ".mp3", ".wav", ".flac", ".m4a", ".aac", ".opus"];
export const MODEL_EXTS = [".glb", ".gltf", ".fbx", ".obj"];
export const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp"];
export const FONT_EXTS = [".ttf", ".otf"];

/** Audio imports at least this long are treated as music when --as is not given. */
export const MUSIC_MIN_SECONDS = 30;
export const THUMBNAIL_SIZE = 256;
export const ICON_SIZE = 64;

export interface ImportOptions {
  /** Where the file came from. Required. */
  origin: LicenseOrigin | string;
  /** License terms text (or a link plus a summary). Required. */
  license: string;
  /** What the file is; inferred from the extension when omitted (audio: music if >= 30 s, else sfx). */
  as?: ImportAs;
  /** Bible tags: mood, area or character ("boss battle", "tavern", "warden"). */
  tags?: string[];
  /** Human name; defaults to the file name. */
  subject?: string;
  description?: string;
  /** Asset kind for 3D models (target height and poly budget). Default "prop". */
  modelKind?: AssetKind;
  /** Music loop points in seconds (default: whole track). */
  loopStart?: number;
  loopEnd?: number;
  /** Blender cleanup runner (defaults to runBlenderCleanup with $BLENDER). */
  blender?: Clients["blender"];
  tools?: MediaTools;
  env?: NodeJS.ProcessEnv;
}

/** Throws if the source/license information is missing or invalid. */
export function validateLicense(o: Pick<ImportOptions, "origin" | "license">) {
  if (!o.origin) throw new Error(`Import refused: source is required (--origin ${LICENSE_ORIGINS.join("|")})`);
  if (!(LICENSE_ORIGINS as readonly string[]).includes(o.origin))
    throw new Error(`Import refused: origin "${o.origin}" must be one of ${LICENSE_ORIGINS.join(", ")}`);
  if (!o.license?.trim()) throw new Error('Import refused: license terms are required (--license "...")');
}

/** Picks the import type from the extension (and duration for audio). */
export function inferImportType(file: string, tools: MediaTools = mediaTools()): ImportAs {
  const ext = extname(file).toLowerCase();
  if (AUDIO_EXTS.includes(ext)) return probeDuration(file, tools) >= MUSIC_MIN_SECONDS ? "music" : "sfx";
  if (MODEL_EXTS.includes(ext)) return "model";
  if (IMAGE_EXTS.includes(ext)) return "texture";
  if (FONT_EXTS.includes(ext)) return "font";
  throw new Error(`Unsupported file type "${ext}". Supported: ${[...AUDIO_EXTS, ...MODEL_EXTS, ...IMAGE_EXTS, ...FONT_EXTS].join(" ")}`);
}

function checkExtension(as: ImportAs, ext: string) {
  const ok =
    as === "music" || as === "sfx" ? AUDIO_EXTS : as === "model" ? MODEL_EXTS : as === "font" ? FONT_EXTS : IMAGE_EXTS;
  if (!ok.includes(ext)) throw new Error(`A ${as} import must be one of ${ok.join(" ")} (got "${ext || "no extension"}")`);
}

function checkFont(file: string) {
  const head = readFileSync(file).subarray(0, 4);
  const tag = head.toString("latin1");
  const ok = head.readUInt32BE(0) === 0x00010000 || tag === "OTTO" || tag === "true" || tag === "ttcf";
  if (!ok) throw new Error(`${basename(file)} does not look like a TrueType/OpenType font`);
}

/** Copies the original (and, for .gltf, the buffers/images it references) under assets/imports/<id>/. */
function copyOriginal(projectDir: string, id: string, src: string): string {
  const dir = join(projectDir, "assets", "imports", id);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, basename(src));
  copyFileSync(src, dest);
  if (extname(src).toLowerCase() === ".gltf") {
    const gltf = JSON.parse(readFileSync(src, "utf8")) as { buffers?: { uri?: string }[]; images?: { uri?: string }[] };
    for (const { uri } of [...(gltf.buffers ?? []), ...(gltf.images ?? [])]) {
      if (!uri || uri.startsWith("data:") || /^[a-z]+:\/\//i.test(uri)) continue;
      const from = resolve(dirname(src), decodeURIComponent(uri));
      const to = resolve(dir, decodeURIComponent(uri));
      if (!to.startsWith(resolve(dir))) throw new Error(`glTF references a file outside its folder: ${uri}`);
      if (!existsSync(from)) throw new Error(`glTF references a missing file: ${uri}`);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    }
  }
  return dest;
}

/**
 * Imports a user file into the project: validates source + license, processes
 * it by type (audio -> loudnorm OGG with loop points for music; 3D -> Blender
 * cleanup to GLB; images -> resized to bible textureResolution plus a 256 px
 * thumbnail and 64 px icon; fonts -> copied), tags it, and registers it as
 * locked, source "imported". References also go into bible visual.concepts
 * (kind "user-reference") so they become GPT style references.
 */
export function importAsset(projectDir: string, file: string, opts: ImportOptions): AssetRecord {
  validateLicense(opts);
  const src = resolve(file);
  if (!existsSync(src) || !statSync(src).isFile()) throw new Error(`No such file: ${file}`);
  const tools = opts.tools ?? mediaTools(opts.env);
  const as = opts.as ?? inferImportType(src, tools);
  if (!IMPORT_TYPES.includes(as)) throw new Error(`--as must be one of ${IMPORT_TYPES.join(", ")}`);
  const ext = extname(src).toLowerCase();
  checkExtension(as, ext);
  if (as === "font") checkFont(src);
  const modelKind = opts.modelKind ?? "prop";
  if (as === "model" && !isModelKind(modelKind)) throw new Error(`Model kind must be character, creature, prop or environment`);

  const bible = loadBibleFrom(projectDir);
  const reg = loadRegistry(projectDir);
  const subject = opts.subject?.trim() || basename(src, extname(src)).replace(/[_-]+/g, " ");
  const id = uniqueId(reg, subject, 48);
  const rel = (p: string) => relative(projectDir, p).split("\\").join("/");
  const asset: AssetRecord = {
    id,
    subject,
    kind: as === "model" ? modelKind : as,
    description: opts.description ?? "",
    status: "cleaned",
    source: "imported",
    locked: true,
    license: { origin: opts.origin, terms: opts.license.trim() },
    tags: [...new Set([as, ...(opts.tags ?? [])].map((t) => t.trim()).filter(Boolean))],
    bibleVersion: bible.meta.version,
    costs: [],
  };
  const original = copyOriginal(projectDir, id, src);
  asset.files = { original: rel(original) };

  switch (as) {
    case "music":
    case "sfx":
      finishAudioAsset(projectDir, asset, original, as, { start: opts.loopStart, end: opts.loopEnd }, tools);
      delete asset.files!.raw; // the original is the raw file
      break;
    case "model": {
      const out = join(projectDir, "assets", "models", `${id}.glb`);
      mkdirSync(dirname(out), { recursive: true });
      const blender = opts.blender ?? ((i, o, s) => runBlenderCleanup(i, o, s, (opts.env ?? process.env).BLENDER ?? "blender"));
      asset.stats = blender(original, out, cleanupSettings(bible, modelKind));
      asset.rawModel = rel(original);
      asset.model = rel(out);
      break;
    }
    case "texture":
    case "image":
    case "reference": {
      const outExt = ext === ".jpeg" ? ".jpg" : ext;
      const target =
        as === "reference"
          ? join(projectDir, "bible", "concepts", `${id}${outExt}`)
          : join(projectDir, "assets", as === "texture" ? "textures" : "images", `${id}${outExt}`);
      resizeImage(original, target, bible.visual.textureResolution, tools);
      const thumb = join(projectDir, "assets", "thumbnails", `${id}.png`);
      resizeImage(original, thumb, THUMBNAIL_SIZE, tools);
      const icon = join(projectDir, "assets", "icons", `${id}.png`);
      squareIcon(original, icon, ICON_SIZE, tools);
      asset.files = { ...asset.files, image: rel(target), thumbnail: rel(thumb), icon: rel(icon) };
      if (as === "reference") addUserReference(projectDir, bible, id, rel(target), subject);
      break;
    }
    case "font": {
      const out = join(projectDir, "assets", "fonts", `${id}${ext}`);
      mkdirSync(dirname(out), { recursive: true });
      copyFileSync(original, out);
      asset.files = { ...asset.files, font: rel(out) };
      break;
    }
  }
  reg.assets.push(asset);
  saveRegistry(projectDir, reg);
  return asset;
}

/** Adds an uploaded sketch/mood image to bible visual.concepts as an approved "user-reference". */
function addUserReference(projectDir: string, bible: Bible, id: string, image: string, subject: string) {
  const visualPath = join(projectDir, "bible", "visual.json");
  const visual = JSON.parse(readFileSync(visualPath, "utf8")) as Bible["visual"];
  if (visual.concepts.some((c) => c.id === id)) return;
  visual.concepts.push({ id, image, kind: "user-reference", subject, approved: true, bibleVersion: bible.meta.version });
  writeFileSync(visualPath, JSON.stringify(visual, null, 2) + "\n");
}
