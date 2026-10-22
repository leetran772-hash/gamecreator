// Godot parity: the GDScript port must produce exactly what the engine-neutral
// TypeScript core produces, for rng streams, levels, spawns and bot play.
// Needs a Godot 4.5+ binary: GODOT=/path/to/godot npx vitest run tests/godot.test.ts
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bible, description } from "../projects/dungeon-crawler/index";
import { parityDump, type ParityOptions } from "../src/qa/parity";
import { exportGodot } from "../scripts/export-godot";
import { boxGlb } from "../src/pipeline/placeholderGlb";

const GODOT = process.env.GODOT;
const SEEDS = ["ashen-1", "playtest-0", "playtest-7", "parity-ünï-🔥", "x"];
const OPTS: ParityOptions = { rng: 48, floors: 3, turns: 400, fullRuns: 25 };

function godot(project: string, script: string, args: string[], marker: string) {
  const r = spawnSync(GODOT!, ["--headless", "--path", project, "--script", script, "--", ...args], {
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  const line = r.stdout.split("\n").find((l) => l.startsWith(marker + " "));
  if (!line) throw new Error(`No ${marker} output (exit ${r.status}).\n${r.stdout.slice(-3000)}\n${r.stderr.slice(-3000)}`);
  const errors = (r.stderr + r.stdout).split("\n").filter((l) => /SCRIPT ERROR|Parse Error|^ERROR:/.test(l) && !/resources still in use/.test(l));
  return { json: JSON.parse(line.slice(marker.length + 1)), errors };
}

describe.skipIf(!GODOT)("godot", () => {
  let out: string;
  let gd: ReturnType<typeof godot>;
  let ts: ReturnType<typeof parityDump>;

  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), "godot-export-"));
    exportGodot({ project: "projects/dungeon-crawler", out, log: () => {} });
    gd = godot(
      out,
      "res://qa/parity.gd",
      ["--seeds", SEEDS.join(","), "--rng", String(OPTS.rng), "--floors", String(OPTS.floors), "--turns", String(OPTS.turns), "--full-runs", String(OPTS.fullRuns)],
      "PARITY_JSON",
    );
    // Round-trip through JSON like the Godot side does.
    ts = JSON.parse(JSON.stringify(parityDump(bible, description, SEEDS, OPTS)));
  }, 300_000);

  afterAll(() => out && rmSync(out, { recursive: true, force: true }));

  it("runs without script errors", () => expect(gd.errors).toEqual([]));

  it("hashString matches (incl. non-ASCII / surrogate pairs)", () => expect(gd.json.hashes).toEqual(ts.hashes));

  const seedData = (src: { seeds: Record<string, unknown> }, seed: string) => src.seeds[seed] as Record<string, Record<string, unknown>>;

  for (const seed of SEEDS) {
    describe(`seed "${seed}"`, () => {
      it("raw rng streams, int/chance/pick/weighted, dice and loot rolls", () => {
        const g = seedData(gd.json, seed).rng!;
        const t = seedData(ts, seed).rng!;
        expect(g.streams).toEqual(t.streams);
        for (const k of ["ints", "chances", "picks", "weighted", "dice", "loot"]) expect(g[k], k).toEqual(t[k]);
      });
      it(`levels for floors 1..${OPTS.floors}`, () => expect(seedData(gd.json, seed).levels).toEqual(seedData(ts, seed).levels));
      it("spawned enemies and floor items", () => expect(seedData(gd.json, seed).spawns).toEqual(seedData(ts, seed).spawns));
      it(`state, messages and events after the bot plays up to ${OPTS.turns} turns`, () => {
        const g = seedData(gd.json, seed).play!;
        const t = seedData(ts, seed).play!;
        expect(g.state).toEqual(t.state);
        expect(g.eventCounts).toEqual(t.eventCounts);
        expect(g.messages).toEqual(t.messages);
        expect(g.actions).toEqual(t.actions);
      });
    });
  }

  it(`full bot runs give identical results (${OPTS.fullRuns} seeds)`, () => expect(gd.json.fullRuns).toEqual(ts.fullRuns));

  it("playtest.gd reports JSON with no issues", () => {
    const pt = godot(out, "res://qa/playtest.gd", ["--runs", "10"], "PLAYTEST_JSON");
    expect(pt.errors).toEqual([]);
    expect(pt.json.runs).toBe(10);
    expect(pt.json.issueCounts).toEqual({ crash: 0, softlock: 0, unreachable: 0 });
    expect(pt.json.results.map((r: { seed: string }) => r.seed)).toEqual(Array.from({ length: 10 }, (_, i) => `playtest-${i}`));
  }, 120_000);

  it("exporter copies bible models and the main scene loads them (GLB at runtime)", () => {
    // A throwaway project whose rat points at a placeholder GLB.
    const proj = mkdtempSync(join(tmpdir(), "godot-proj-"));
    const out2 = mkdtempSync(join(tmpdir(), "godot-export-glb-"));
    try {
      cpSync("projects/dungeon-crawler", proj, { recursive: true });
      mkdirSync(join(proj, "assets/models"), { recursive: true });
      writeFileSync(join(proj, "assets/models/crypt-rat.glb"), boxGlb(0.4, 0.3, 0.6));
      const lore = { ...bible.lore, bestiary: { ...bible.lore.bestiary, rat: { ...bible.lore.bestiary.rat!, model: "assets/models/crypt-rat.glb" } } };
      writeFileSync(join(proj, "bible/lore.json"), JSON.stringify(lore));
      const res = exportGodot({ project: proj, out: out2, log: () => {} });
      expect(res.models).toEqual(["assets/models/crypt-rat.glb"]);
      const smoke = godot(out2, "res://qa/smoke.gd", ["--frames", "5"], "SMOKE_JSON");
      expect(smoke.errors).toEqual([]);
      expect(smoke.json.title).toBe(bible.meta.title);
      expect(smoke.json.modelsLoaded).toContain("assets/models/crypt-rat.glb");
      expect(smoke.json.entities).toBeGreaterThan(1);
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(out2, { recursive: true, force: true });
    }
  }, 120_000);
});
