// Asset pipeline CLI (also what Claude Code calls as a tool).
//
//   npm run asset -- concept "crypt rat" --kind creature [--desc "..."] [--yes]
//   npm run asset -- approve crypt-rat
//   npm run asset -- to3d crypt-rat [--yes]
//   npm run asset -- cleanup crypt-rat
//   npm run asset -- list
//
// Flags: --project <dir> (default projects/dungeon-crawler), --dry-run (no API calls, no spend).
// Paid steps print a cost estimate and stop unless --yes is given.
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { AssetPipeline, dryRunClients, liveClients } from "../src/pipeline/assetPipeline";
import { ApprovalRequired } from "../src/pipeline/gates";
import { loadRegistry, totalCost } from "../src/pipeline/registry";
import type { AssetKind } from "../src/pipeline/conceptPrompt";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    project: { type: "string", default: "projects/dungeon-crawler" },
    kind: { type: "string", default: "prop" },
    desc: { type: "string", default: "" },
    yes: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

const [cmd, arg] = positionals;
const projectDir = resolve(values.project!);
const pipeline = new AssetPipeline(projectDir, values["dry-run"] ? dryRunClients() : liveClients(), undefined, (m) => console.log(m));
const kinds = ["character", "creature", "prop", "environment"];

async function main() {
  switch (cmd) {
    case "concept": {
      if (!arg) throw new Error('usage: concept "<subject>" --kind character|creature|prop|environment');
      if (!kinds.includes(values.kind!)) throw new Error(`--kind must be one of ${kinds.join(", ")}`);
      const { asset, cached } = await pipeline.concept(arg, {
        kind: values.kind as AssetKind,
        description: values.desc,
        approved: values.yes!,
        force: values.force,
      });
      if (!cached) console.log(`Concept saved: ${asset.concept}\nReview it, then: npm run asset -- approve ${asset.id}`);
      return;
    }
    case "approve": {
      const a = pipeline.approve(need(arg));
      console.log(`Approved ${a.id}; look locked and added to the bible as a style reference.\nNext: npm run asset -- to3d ${a.id}`);
      return;
    }
    case "to3d": {
      const a = await pipeline.to3d(need(arg), values.yes!);
      console.log(`Raw model: ${a.rawModel}\nNext: npm run asset -- cleanup ${a.id}`);
      return;
    }
    case "cleanup": {
      const a = pipeline.cleanup(need(arg));
      console.log(`Clean model: ${a.model} (${a.stats?.triangles} tris, LODs ${a.stats?.lods.join("/")})`);
      return;
    }
    case "list": {
      const reg = loadRegistry(projectDir);
      if (!reg.assets.length) console.log("No assets yet.");
      for (const a of reg.assets) {
        const spend = a.costs.reduce((s, c) => s + c.usd, 0);
        console.log(
          `${a.id.padEnd(22)} ${a.status.padEnd(9)} ${a.kind.padEnd(11)} ${a.source}${a.locked ? " locked" : ""}  bible v${a.bibleVersion}  $${spend.toFixed(2)}`,
        );
      }
      console.log(`Total estimated spend: $${totalCost(reg).toFixed(2)}`);
      return;
    }
    default:
      console.log("Commands: concept, approve, to3d, cleanup, list. See scripts/asset.ts for usage.");
      process.exitCode = 1;
  }
}

function need(v: string | undefined): string {
  if (!v) throw new Error("missing asset id");
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
