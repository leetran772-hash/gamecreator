// Balance simulation: thousands of seeded duels and loot rolls to catch broken
// difficulty or drop rates.
import { resolveAttack, type Combatant } from "../core/combat";
import { expectedDropRates, rollLoot } from "../core/loot";
import { Rng } from "../core/seeder";
import type { Bible } from "../bible/types";
import type { GameDescription } from "../core/description";

export interface DuelStats {
  enemy: string;
  minFloor: number;
  winRate: number;
  avgHpLost: number;
  avgRounds: number;
}

/** Player (attacks first) vs one enemy until one drops. */
export function duel(rng: Rng, player: Combatant & { hp: number }, enemy: Combatant & { hp: number }) {
  let php = player.hp;
  let ehp = enemy.hp;
  let rounds = 0;
  while (php > 0 && ehp > 0 && rounds < 500) {
    rounds++;
    const a = resolveAttack(rng, player, enemy);
    if (a.hit) ehp -= a.damage;
    if (ehp <= 0) break;
    const b = resolveAttack(rng, enemy, player);
    if (b.hit) php -= b.damage;
  }
  return { won: ehp <= 0, hpLost: player.hp - Math.max(0, php), rounds };
}

export function duelTable(bible: Bible, desc: GameDescription, player = bible.lore.player): DuelStats[] {
  return Object.values(bible.lore.bestiary).map((e) => {
    const rng = new Rng(`balance:duel:${e.id}`);
    let wins = 0;
    let hp = 0;
    let rounds = 0;
    for (let i = 0; i < desc.qa.duelRuns; i++) {
      const r = duel(rng, player, e);
      if (r.won) wins++;
      hp += r.hpLost;
      rounds += r.rounds;
    }
    const n = desc.qa.duelRuns;
    return { enemy: e.id, minFloor: e.minFloor, winRate: wins / n, avgHpLost: hp / n, avgRounds: rounds / n };
  });
}

export interface LootDrift {
  table: string;
  item: string;
  expected: number;
  observed: number;
}

/** Rolls every loot table many times and reports items whose observed rate drifts from the weights. */
export function lootCheck(bible: Bible, desc: GameDescription): { drifts: LootDrift[]; observed: Record<string, Record<string, number>> } {
  const drifts: LootDrift[] = [];
  const observed: Record<string, Record<string, number>> = {};
  for (const [id, table] of Object.entries(bible.lore.lootTables)) {
    const rng = new Rng(`balance:loot:${id}`);
    const counts: Record<string, number> = {};
    const single = { ...table, rolls: 1 };
    for (let i = 0; i < desc.qa.lootRolls; i++) for (const d of rollLoot(rng, single, "x")) counts[d.itemId] = (counts[d.itemId] ?? 0) + 1;
    observed[id] = {};
    for (const [item, expected] of Object.entries(expectedDropRates(table))) {
      const obs = (counts[item] ?? 0) / desc.qa.lootRolls;
      observed[id]![item] = obs;
      if (Math.abs(obs - expected) > desc.qa.lootTolerance) drifts.push({ table: id, item, expected, observed: obs });
    }
  }
  return { drifts, observed };
}
