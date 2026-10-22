// Cost ledger for spend that is not tied to one asset (e.g. Anthropic usage
// from the director's chat turns). Asset spend lives on each asset record.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CostEntry } from "../pipeline/registry";
import { loadRegistry } from "../pipeline/registry";

const file = (projectDir: string) => join(projectDir, "costs.json");

export function loadLedger(projectDir: string): CostEntry[] {
  const f = file(projectDir);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as CostEntry[]) : [];
}

export function recordCost(projectDir: string, entry: Omit<CostEntry, "at">) {
  const list = loadLedger(projectDir);
  list.push({ ...entry, at: new Date().toISOString() });
  writeFileSync(file(projectDir), JSON.stringify(list, null, 2) + "\n");
}

/** Spend per service across asset records and the ledger. */
export function costSummary(projectDir: string): { byService: Record<string, number>; total: number } {
  const all = [...loadRegistry(projectDir).assets.flatMap((a) => a.costs), ...loadLedger(projectDir)];
  const byService: Record<string, number> = { anthropic: 0, openai: 0, meshy: 0, elevenlabs: 0 };
  for (const c of all) byService[c.service] = (byService[c.service] ?? 0) + c.usd;
  return { byService, total: Object.values(byService).reduce((s, v) => s + v, 0) };
}
