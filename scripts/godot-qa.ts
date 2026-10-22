// Godot QA: exports the project, runs the headless bot playtest inside Godot
// and fails on crashes, softlocks, unreachable areas, script errors, a win
// rate outside the game.json target, or any run that plays out differently
// from the TypeScript core with the same seed.
//   GODOT=/path/to/godot npx tsx scripts/godot-qa.ts [--project projects/dungeon-crawler] [--runs 200] [--no-compare] [--screenshot]
// --screenshot renders the main scene under xvfb-run (headless Godot cannot
// render) and saves qa-output/godot-<seed>.png for review against the bible.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Bible } from "../src/bible/types";
import type { GameDescription } from "../src/core/description";
import { playRun, type Issue, type RunResult } from "../src/qa/playtest";
import { exportGodot } from "./export-godot";

const { values } = parseArgs({
  options: {
    project: { type: "string", default: "projects/dungeon-crawler" },
    out: { type: "string" },
    runs: { type: "string" },
    "no-compare": { type: "boolean", default: false },
    screenshot: { type: "boolean", default: false },
  },
});
const godot = process.env.GODOT;
if (!godot) {
  console.error("Set GODOT=/path/to/godot (Godot 4.5+) to run the Godot playtest.");
  process.exit(2);
}

const projectDir = resolve(values.project!);
const readJson = (p: string) => JSON.parse(readFileSync(join(projectDir, p), "utf8"));
const bible = Object.fromEntries(["meta", "visual", "audio", "lore", "code"].map((l) => [l, readJson(`bible/${l}.json`)])) as unknown as Bible;
const desc = readJson("game.json") as GameDescription;
const runs = Number(values.runs ?? desc.qa.playtestRuns);

let failed = false;
const fail = (msg: string) => {
  failed = true;
  console.log(`  FAIL ${msg}`);
};

console.log(`Godot QA: ${bible.meta.title}\n`);
const { out } = exportGodot({ project: projectDir, out: values.out ?? join("build/godot", basename(projectDir)), log: (m) => console.log(m) });

console.log(`\nPlaytest in Godot: ${runs} bot runs`);
const t0 = Date.now();
const r = spawnSync(godot, ["--headless", "--path", out, "--script", "res://qa/playtest.gd", "--", "--runs", String(runs)], {
  encoding: "utf8",
  timeout: 1_800_000,
  maxBuffer: 256 * 1024 * 1024,
});
const line = r.stdout?.split("\n").find((l) => l.startsWith("PLAYTEST_JSON "));
if (!line) {
  console.log(r.stdout?.slice(-2000), r.stderr?.slice(-2000));
  fail(`no playtest report (exit ${r.status})`);
  process.exit(1);
}
const scriptErrors = `${r.stdout}\n${r.stderr}`.split("\n").filter((l) => /SCRIPT ERROR|Parse Error/.test(l));
scriptErrors.slice(0, 5).forEach((l) => fail(`godot: ${l}`));
const pt = JSON.parse(line.slice("PLAYTEST_JSON ".length)) as {
  winRate: number;
  deathsByFloor: Record<string, number>;
  avgTurns: number;
  avgKills: number;
  avgGold: number;
  issues: Issue[];
  results: RunResult[];
  godot: string;
};
const [lo, hi] = desc.qa.botWinRate;
console.log(`  ${pt.godot}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`  bot win rate ${(pt.winRate * 100).toFixed(1)}% (target ${lo * 100}-${hi * 100}%)`);
console.log(`  deaths by floor ${JSON.stringify(pt.deathsByFloor)}`);
console.log(`  avg turns ${pt.avgTurns.toFixed(0)}, kills ${pt.avgKills.toFixed(0)}, gold ${pt.avgGold.toFixed(0)}`);
if (pt.winRate < lo || pt.winRate > hi) fail("bot win rate outside target");
for (const k of ["crash", "softlock", "unreachable"]) {
  const list = pt.issues.filter((i) => i.kind === k);
  if (list.length) fail(`${list.length} ${k} issue(s), first: seed ${list[0]!.seed} floor ${list[0]!.floor}: ${list[0]!.detail.split("\n")[0]}`);
}

if (!values["no-compare"]) {
  console.log("\nParity: same seeds in the TypeScript core");
  const mismatches = pt.results.filter((g) => {
    const t = playRun(bible, desc, g.seed, []);
    return JSON.stringify(t) !== JSON.stringify({ seed: g.seed, outcome: g.outcome, floor: g.floor, turns: g.turns, kills: g.kills, gold: g.gold, level: g.level });
  });
  if (mismatches.length) fail(`${mismatches.length}/${pt.results.length} runs differ from TypeScript, first: ${mismatches[0]!.seed}`);
  else console.log(`  ok (${pt.results.length} runs identical)`);
}

if (values.screenshot) {
  console.log("\nScreenshot");
  if (spawnSync("sh", ["-c", "command -v xvfb-run"]).status !== 0) console.log("  skipped: xvfb-run not found (headless Godot cannot render)");
  else {
    mkdirSync("qa-output", { recursive: true });
    const png = resolve("qa-output/godot-visual-1.png");
    const shot = spawnSync(
      "xvfb-run",
      ["-a", "-s", "-screen 0 1280x800x24", godot, "--path", out, "--rendering-driver", "opengl3", "--audio-driver", "Dummy",
        "--script", "res://qa/screenshot.gd", "--", "--seed", "visual-1", "--turns", "60", "--out", png],
      { encoding: "utf8", timeout: 300_000 },
    );
    const res = shot.stdout?.split("\n").find((l) => l.startsWith("SCREENSHOT_JSON "));
    if (res && JSON.parse(res.slice(16)).ok) console.log(`  saved ${relative(process.cwd(), png)} (${JSON.parse(res.slice(16)).renderer})`);
    else fail(`screenshot failed: ${(shot.stderr || shot.stdout || "").slice(-500)}`);
  }
}

console.log(failed ? "\nGODOT QA FAILED" : "\nGODOT QA PASSED");
process.exit(failed ? 1 : 0);
