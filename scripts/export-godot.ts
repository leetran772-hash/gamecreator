// Godot exporter: turns a project folder into a runnable Godot 4 project.
//   npx tsx scripts/export-godot.ts --project projects/dungeon-crawler [--out build/godot/dungeon-crawler]
//                                   [--import] [--export web|linux]
// Copies the genre template (engines/godot/<template>/), writes the bible
// layers and game.json into data/, copies the cleaned GLBs the bible or the
// asset registry point at, and names the project after bible/meta.json.
// The template reads everything from res://data/ at runtime, so no game rules
// are generated or duplicated here.
// --import runs `godot --headless --import` (needs $GODOT) so GLBs become
// native resources. --export also needs Godot export templates; without them
// it prints how to install them and exits 0.
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAYERS = ["meta", "visual", "audio", "lore", "code"] as const;
const PRESETS = { web: { name: "Web", file: "web/index.html" }, linux: { name: "Linux", file: "linux/game.x86_64" } } as const;

export interface ExportOptions {
  project: string;
  out?: string;
  /** Run `godot --import` after writing the project (needs GODOT). */
  import?: boolean;
  export?: keyof typeof PRESETS;
  godot?: string;
  log?: (msg: string) => void;
}

export interface ExportResult {
  out: string;
  title: string;
  models: string[];
  missingModels: string[];
  imported: boolean;
  exported?: string;
  skipped: string[];
}

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const gdString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;

/** Every GLB the bible or the asset registry points at, project-relative. */
export function referencedModels(projectDir: string): string[] {
  const lore = readJson(join(projectDir, "bible/lore.json"));
  const paths = new Set<string>();
  const add = (p?: string) => p && p.endsWith(".glb") && paths.add(p.replace(/^\.\//, ""));
  add(lore.player?.model);
  for (const e of Object.values(lore.bestiary ?? {}) as { model?: string }[]) add(e.model);
  for (const it of Object.values(lore.items ?? {}) as { model?: string }[]) add(it.model);
  const registry = join(projectDir, "assets.json");
  if (existsSync(registry)) {
    for (const a of readJson(registry).assets ?? []) if (a.model && ["cleaned", "in-game"].includes(a.status)) add(a.model);
  }
  // LODs from the Blender cleanup sit next to the model.
  for (const p of [...paths]) for (const lod of [1, 2]) if (existsSync(join(projectDir, p.replace(/\.glb$/, `.lod${lod}.glb`)))) paths.add(p.replace(/\.glb$/, `.lod${lod}.glb`));
  return [...paths].sort();
}

function run(godot: string, args: string[], log: (m: string) => void) {
  log(`  $ ${basename(godot)} ${args.join(" ")}`);
  const r = spawnSync(godot, args, { encoding: "utf8", timeout: 600_000 });
  if (r.status !== 0) throw new Error(`Godot failed (${r.status}): ${(r.stderr || r.stdout || "").slice(-2000)}`);
  return r.stdout;
}

export function exportGodot(o: ExportOptions): ExportResult {
  const log = o.log ?? console.log;
  const projectDir = resolve(o.project);
  const desc = readJson(join(projectDir, "game.json"));
  const meta = readJson(join(projectDir, "bible/meta.json"));
  const template = join(ROOT, "engines/godot", desc.template);
  if (!existsSync(join(template, "project.godot"))) throw new Error(`No Godot template for "${desc.template}" at ${template}`);
  const out = resolve(o.out ?? join(ROOT, "build/godot", basename(projectDir)));
  const skipped: string[] = [];

  // Fresh copy of the template; keep .godot/ (import cache) between exports.
  mkdirSync(out, { recursive: true });
  for (const d of ["data", "assets", "core", "qa", "scenes", "ui"]) rmSync(join(out, d), { recursive: true, force: true });
  cpSync(template, out, {
    recursive: true,
    filter: (src) => !relative(template, src).split(/[\\/]/).some((part) => part === ".godot" || part === "export"),
  });

  // Bible layers + engine-neutral description, read at runtime from res://data/.
  mkdirSync(join(out, "data"), { recursive: true });
  for (const layer of LAYERS) copyFileSync(join(projectDir, "bible", `${layer}.json`), join(out, "data", `${layer}.json`));
  copyFileSync(join(projectDir, "game.json"), join(out, "data/game.json"));

  // Cleaned GLBs, at the same project-relative path the bible uses (res://assets/models/x.glb).
  const models: string[] = [];
  const missingModels: string[] = [];
  for (const p of referencedModels(projectDir)) {
    const src = join(projectDir, p);
    if (!existsSync(src)) {
      missingModels.push(p);
      log(`  warning: ${p} is referenced but missing; the game falls back to a primitive`);
      continue;
    }
    mkdirSync(dirname(join(out, p)), { recursive: true });
    copyFileSync(src, join(out, p));
    models.push(p);
  }

  // Project name and description from the bible.
  const cfgPath = join(out, "project.godot");
  const cfg = readFileSync(cfgPath, "utf8")
    .replace(/^config\/name=.*$/m, `config/name=${gdString(meta.title)}`)
    .replace(/^config\/description=.*$/m, `config/description=${gdString(meta.pitch ?? "")}`);
  writeFileSync(cfgPath, cfg);
  writeFileSync(
    join(out, "data/export.json"),
    JSON.stringify({ project: basename(projectDir), template: desc.template, bibleVersion: meta.version, models }, null, 2) + "\n",
  );
  log(`Godot project "${meta.title}" -> ${relative(process.cwd(), out) || "."} (${models.length} model(s))`);

  const godot = o.godot ?? process.env.GODOT;
  let imported = false;
  let exported: string | undefined;
  if (o.import || o.export) {
    if (!godot) skipped.push("import: set GODOT=/path/to/godot to import resources");
    else {
      run(godot, ["--headless", "--path", out, "--import"], log);
      imported = true;
    }
  }
  if (o.export) {
    const preset = PRESETS[o.export];
    if (!preset) throw new Error(`--export must be one of ${Object.keys(PRESETS).join(", ")}`);
    const version = godot ? spawnSync(godot, ["--version"], { encoding: "utf8" }).stdout.trim() : "";
    const short = version.split(".").slice(0, 4).join("."); // 4.5.1.stable
    const templates = join(process.env.GODOT_TEMPLATES ?? join(homedir(), ".local/share/godot/export_templates"), short);
    if (!godot) skipped.push(`export ${o.export}: GODOT not set`);
    else if (!existsSync(templates)) {
      skipped.push(
        `export ${o.export}: no export templates at ${templates}. Install them from the Godot editor (Editor > Manage Export Templates) or unzip Godot_v${short.replace(/\.stable$/, "-stable")}_export_templates.tpz there.`,
      );
    } else {
      const target = join(out, "export", preset.file);
      mkdirSync(dirname(target), { recursive: true });
      run(godot, ["--headless", "--path", out, "--export-release", preset.name, target], log);
      exported = target;
    }
  }
  for (const s of skipped) log(`  skipped ${s}`);
  return { out, title: meta.title, models, missingModels, imported, exported, skipped };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      project: { type: "string", default: "projects/dungeon-crawler" },
      out: { type: "string" },
      import: { type: "boolean", default: false },
      export: { type: "string" },
    },
  });
  try {
    exportGodot({ project: values.project!, out: values.out, import: values.import, export: values.export as ExportOptions["export"] });
  } catch (err) {
    console.error(String((err as Error).message ?? err));
    process.exit(1);
  }
}
