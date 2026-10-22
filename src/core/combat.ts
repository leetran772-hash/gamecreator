// D&D-style combat: d20 + attack bonus vs armor class. A natural 20 always hits
// and doubles the damage dice; a natural 1 always misses.
import { parseDice, rollDice, type Rng } from "./seeder";

export interface Combatant {
  name: string;
  ac: number;
  attackBonus: number;
  damage: string;
}

export interface AttackResult {
  roll: number;
  total: number;
  targetAc: number;
  hit: boolean;
  crit: boolean;
  damage: number;
}

export function resolveAttack(rng: Rng, attacker: Combatant, defender: Combatant): AttackResult {
  const roll = rng.int(1, 20);
  const total = roll + attacker.attackBonus;
  const crit = roll === 20;
  const hit = crit || (roll !== 1 && total >= defender.ac);
  let damage = 0;
  if (hit) {
    const { count } = parseDice(attacker.damage);
    damage = Math.max(1, rollDice(rng, attacker.damage, crit ? count : 0).total);
  }
  return { roll, total, targetAc: defender.ac, hit, crit, damage };
}

/** Chance that `attacker` hits `defender` on one swing. */
export function hitChance(attacker: Combatant, defender: Combatant): number {
  let hits = 0;
  for (let roll = 1; roll <= 20; roll++) {
    if (roll === 20 || (roll !== 1 && roll + attacker.attackBonus >= defender.ac)) hits++;
  }
  return hits / 20;
}
