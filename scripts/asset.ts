// Asset pipeline CLI (also what Claude Code calls as a tool).
//
// 3D:      concept "crypt rat" --kind creature [--desc "..."] [--yes]
//          approve crypt-rat | to3d crypt-rat [--yes] | cleanup crypt-rat
// Audio:   sfx "bone clatter" [--duration 1.5] [--yes]
//          music combat [--seconds 60] [--loop-start 0 --loop-end 58] [--yes]
//          voice warden "Turn back, little candle." [--yes]
//          voices lines.json [--yes]        (batch: one gate for all lines)
// Imports: import <file> --origin purchased-pack|commissioned|royalty-free|in-house --license "..."
//            [--tag boss --tag crypt] [--as music|sfx|model|texture|image|font|reference] [--kind prop] [--subject "..."]
// Bible:   bump-bible | stale | rematerial <id> | regenerate <id> [--yes]
// QA:      qa-assets
//          list
//
// Flags: --project <dir> (default projects/dungeon-crawler), --dry-run (no API calls, no spend),
// --force (generate again even if cached). Paid steps print a cost estimate and stop unless --yes.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { AssetPipeline, dryRunClients, liveClients } from "../src/pipeline/assetPipeline";
import { AudioPipeline, dryRunAudioClients, liveAudioClients, type VoiceLine } from "../src/pipeline/audioPipeline";
import { bumpBibleVersion, staleAssets } from "../src/pipeline/bibleVersion";
import type { AssetKind } from "../src/pipeline/conceptPrompt";
import { ApprovalRequired } from "../src/pipeline/gates";
import { importAsset, IMPORT_TYPES, type ImportAs } from "../src/pipeline/imports";
import { findAsset, isAudioKind, loadRegistry, MODEL_KINDS, totalCost } from "../src/pipeline/registry";
import { checkProjectAssets } from "../src/qa/assets";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    project: { type: "string", default: "projects/dungeon-crawler" },
    kind: { type: "string", default: "prop" },
    desc: { type: "string", default: "" },
    yes: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    duration: { type: "string" },
    influence: { type: "string" },
    seconds: { type: "string" },
    "loop-start": { type: "string" },
    "loop-end": { type: "string" },
    origin: { type: "string" },
    license: { type: "string" },
    tag: { type: "string", multiple: true, default: [] },
    as: { type: "string" },
    subject: { type: "string" },
  },
});

const [cmd, arg, arg2] = positionals;
const projectDir = resolve(values.project!);
const dry = values["dry-run"]!;
const log = (m: string) => console.log(m);
const pipeline = () => new AssetPipeline(projectDir, dry ? dryRunClients() : liveClients(), undefined, log);
const audio = () => new AudioPipeline(projectDir, dry ? dryRunAudioClients() : liveAudioClients(), undefined, log);
const num = (v: string | undefined, name: string) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
  return n;
};
const gen = { approved: values.yes!, force: values.force, tags: values.tag };

async function main() {
  switch (cmd) {
    case "concept": {
      if (!arg) throw new Error('usage: concept "<subject>" --kind character|creature|prop|environment');
      if (!MODEL_KINDS.includes(values.kind as AssetKind)) throw new Error(`--kind must be one of ${MODEL_KINDS.join(", ")}`);
      const { asset, cached } = await pipeline().concept(arg, {
        kind: values.kind as AssetKind,
        description: values.desc,
        approved: values.yes!,
        force: values.force,
        tags: values.tag,
      });
      if (!cached) console.log(`Concept saved: ${asset.concept}\nReview it, then: npm run asset -- approve ${asset.id}`);
      return;
    }
    case "approve": {
      const a = pipeline().approve(need(arg));
      console.log(`Approved ${a.id}; look locked and added to the bible as a style reference.\nNext: npm run asset -- to3d ${a.id}`);
      return;
    }
    case "to3d": {
      const a = await pipeline().to3d(need(arg), values.yes!);
      console.log(`Raw model: ${a.rawModel}\nNext: npm run asset -- cleanup ${a.id}`);
      return;
    }
    case "cleanup": {
      const a = pipeline().cleanup(need(arg));
      console.log(`Clean model: ${a.model} (${a.stats?.triangles} tris, LODs ${a.stats?.lods.join("/")})`);
      return;
    }
    case "sfx": {
      const { asset, cached } = await audio().sfx(need(arg, 'usage: sfx "<description>" [--duration s]'), {
        ...gen,
        durationSeconds: num(values.duration, "duration"),
        promptInfluence: num(values.influence, "influence"),
      });
      printAudio(asset.id, cached);
      return;
    }
    case "music": {
      const { asset, cached } = await audio().music(need(arg, "usage: music <mood> [--seconds n]"), {
        ...gen,
        seconds: num(values.seconds, "seconds"),
        loopStart: num(values["loop-start"], "loop-start"),
        loopEnd: num(values["loop-end"], "loop-end"),
      });
      printAudio(asset.id, cached);
      return;
    }
    case "voice": {
      if (!arg || !arg2) throw new Error('usage: voice <characterId> "<line>"');
      const { asset, cached } = await audio().voice(arg, arg2, gen);
      printAudio(asset.id, cached);
      return;
    }
    case "voices": {
      const raw = JSON.parse(readFileSync(need(arg, "usage: voices <lines.json>  ([{characterId, text, id?, tags?}])"), "utf8")) as
        | VoiceLine[]
        | { lines: VoiceLine[] };
      const lines = Array.isArray(raw) ? raw : raw.lines;
      const r = await audio().voiceBatch(lines, { approved: values.yes!, force: values.force });
      for (const a of r.assets) console.log(`${a.id.padEnd(40)} ${a.audio?.file} (${a.audio?.duration}s)${r.cached.includes(a.id) ? " cached" : ""}`);
      if (r.estimate) console.log(`Batch: ${r.estimate.detail}, est. $${r.estimate.usd.toFixed(2)}`);
      return;
    }
    case "import": {
      if (values.as && !IMPORT_TYPES.includes(values.as as ImportAs)) throw new Error(`--as must be one of ${IMPORT_TYPES.join(", ")}`);
      const a = importAsset(projectDir, need(arg, 'usage: import <file> --origin ... --license "..."'), {
        origin: values.origin ?? "",
        license: values.license ?? "",
        as: values.as as ImportAs | undefined,
        tags: values.tag,
        subject: values.subject,
        description: values.desc,
        modelKind: values.kind as AssetKind,
        loopStart: num(values["loop-start"], "loop-start"),
        loopEnd: num(values["loop-end"], "loop-end"),
      });
      console.log(`Imported ${a.id} (${a.kind}, locked) tags: ${a.tags.join(", ")}`);
      for (const [role, f] of Object.entries({ ...a.files, ...(a.model ? { model: a.model } : {}), ...(a.audio ? { ogg: a.audio.file } : {}) }))
        console.log(`  ${role.padEnd(10)} ${f}`);
      return;
    }
    case "bump-bible": {
      console.log(`Bible is now v${bumpBibleVersion(projectDir)}. Run: npm run asset -- stale`);
      return;
    }
    case "stale": {
      const r = staleAssets(projectDir);
      if (!r.stale.length) console.log(`No stale assets (bible v${r.bibleVersion}).`);
      for (const s of r.stale) console.log(`${s.id.padEnd(30)} ${s.kind.padEnd(11)} built v${s.bibleVersion}  -> ${s.action} ${s.id}`);
      return;
    }
    case "rematerial": {
      const a = pipeline().rematerial(need(arg));
      console.log(`Re-materialed ${a.id}: ${a.model} (bible v${a.bibleVersion})`);
      return;
    }
    case "regenerate": {
      const id = need(arg);
      const a = isAudioKind(findAsset(loadRegistry(projectDir), id).kind)
        ? await audio().regenerate(id, values.yes!)
        : await pipeline().regenerate(id, values.yes!);
      console.log(`Regenerated ${a.id} (bible v${a.bibleVersion})`);
      return;
    }
    case "qa-assets": {
      const r = checkProjectAssets(projectDir);
      for (const i of r.issues) console.log(`  FAIL ${i.assetId}: [${i.check}] ${i.message}`);
      console.log(`${r.checked} asset(s) checked, ${r.issues.length} issue(s).`);
      if (r.issues.length) process.exitCode = 1;
      return;
    }
    case "list": {
      const reg = loadRegistry(projectDir);
      if (!reg.assets.length) console.log("No assets yet.");
      for (const a of reg.assets) {
        const spend = a.costs.reduce((s, c) => s + c.usd, 0);
        console.log(
          `${a.id.padEnd(30)} ${a.status.padEnd(9)} ${a.kind.padEnd(11)} ${a.source}${a.locked ? " locked" : ""}  bible v${a.bibleVersion}  $${spend.toFixed(2)}${a.tags.length ? `  [${a.tags.join(", ")}]` : ""}${a.license ? `  license: ${a.license.origin}` : ""}`,
        );
      }
      console.log(`Total estimated spend: $${totalCost(reg).toFixed(2)}`);
      return;
    }
    default:
      console.log(
        "Commands: concept, approve, to3d, cleanup, sfx, music, voice, voices, import, bump-bible, stale, rematerial, regenerate, qa-assets, list. See scripts/asset.ts for usage.",
      );
      process.exitCode = 1;
  }
}

function printAudio(id: string, cached: boolean) {
  const a = findAsset(loadRegistry(projectDir), id);
  const loop = a.audio?.loopEnd !== undefined ? `, loop ${a.audio.loopStart}-${a.audio.loopEnd}s` : "";
  console.log(`${cached ? "Cached" : "Saved"}: ${a.id} -> ${a.audio?.file} (${a.audio?.duration}s${loop})`);
}

function need(v: string | undefined, usage = "missing asset id"): string {
  if (!v) throw new Error(usage);
  return v;
}

main().catch((err) => {
  if (err instanceof ApprovalRequired) {
    console.log(`${err.message}\nRe-run with --yes to approve this spend.`);
    process.exitCode = 2;
    return;
  }
  console.error(String(err instanceof Error ? err.message : err));
  process.exitCode = 1;
});
