// Runs every automated check for a project and exits non-zero on problems.
// Usage: npm run qa
import { bible, description } from "../projects/dungeon-crawler/index";
import { validateBible } from "../src/bible/validate";
import { duelTable, lootCheck } from "../src/qa/balance";
import { playtest } from "../src/qa/playtest";

let failed = false;
const fail = (msg: string) => {
  failed = true;
  console.log(`  FAIL ${msg}`);
};

console.log(`QA: ${bible.meta.title} (bible v${bible.meta.version})\n`);

console.log("Bible");
const problems = validateBible(bible);
problems.forEach(fail);
if (!problems.length) console.log("  ok");

console.log("\nBalance: base player vs each enemy");
for (const d of duelTable(bible, description)) {
  console.log(
    `  ${d.enemy.padEnd(10)} floor ${d.minFloor}+  win ${(d.winRate * 100).toFixed(1).padStart(5)}%  hp lost ${d.avgHpLost.toFixed(1).padStart(4)}  rounds ${d.avgRounds.toFixed(1)}`,
  );
  if (d.minFloor === 1 && d.winRate < description.qa.minFloorOneDuelWinRate)
    fail(`${d.enemy} beats a fresh player too often (${(d.winRate * 100).toFixed(1)}%)`);
}

console.log("\nBalance: loot tables");
const loot = lootCheck(bible, description);
loot.drifts.forEach((d) => fail(`${d.table}/${d.item} expected ${d.expected.toFixed(3)} observed ${d.observed.toFixed(3)}`));
if (!loot.drifts.length) console.log(`  ok (${Object.keys(loot.observed).length} tables x ${description.qa.lootRolls} rolls)`);

console.log(`\nPlaytest: ${description.qa.playtestRuns} bot runs`);
const pt = playtest(bible, description);
const [lo, hi] = description.qa.botWinRate;
console.log(`  bot win rate ${(pt.winRate * 100).toFixed(1)}% (target ${lo * 100}-${hi * 100}%)`);
console.log(`  deaths by floor ${JSON.stringify(pt.deathsByFloor)}`);
const avg = (k: "turns" | "kills" | "gold") => (pt.results.reduce((s, r) => s + r[k], 0) / pt.results.length).toFixed(0);
console.log(`  avg turns ${avg("turns")}, kills ${avg("kills")}, gold ${avg("gold")}`);
if (pt.winRate < lo || pt.winRate > hi) fail(`bot win rate outside target`);
const byKind = (k: string) => pt.issues.filter((i) => i.kind === k);
for (const k of ["crash", "softlock", "unreachable"]) {
  const list = byKind(k);
  if (list.length) fail(`${list.length} ${k} issue(s), first: seed ${list[0]!.seed} floor ${list[0]!.floor}: ${list[0]!.detail.split("\n")[0]}`);
}

console.log(failed ? "\nQA FAILED" : "\nQA PASSED");
process.exit(failed ? 1 : 0);
