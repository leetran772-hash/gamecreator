// Loot roller. Hard dependency on the seeder; listens for combat's
// enemyDefeated event. Each drop uses a stream keyed by the enemy's uid, so
// adding or removing other enemies never changes what this one drops.
import type { ItemInstance } from "./contracts";
import type { LootTable } from "../bible/types";
import type { Rng } from "./seeder";

export function rollLoot(rng: Rng, table: LootTable, uidPrefix: string): ItemInstance[] {
  const drops: ItemInstance[] = [];
  const entries = [...table.entries, { item: "", weight: table.nothingWeight }];
  for (let i = 0; i < table.rolls; i++) {
    const pick = rng.weighted(entries);
    if (pick.item) drops.push({ uid: `${uidPrefix}-${i}`, itemId: pick.item });
  }
  return drops;
}

/** Expected chance of each item per roll, for balance checks. */
export function expectedDropRates(table: LootTable): Record<string, number> {
  const total = table.entries.reduce((s, e) => s + e.weight, 0) + table.nothingWeight;
  const out: Record<string, number> = {};
  for (const e of table.entries) out[e.item] = (out[e.item] ?? 0) + e.weight / total;
  return out;
}
