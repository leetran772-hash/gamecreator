// Seeder: deterministic random numbers with named sub-streams.
// Every consumer (loot, level layout, combat...) forks its own stream from the
// main seed, so adding an enemy never shifts later loot drops and saved runs
// stay reproducible as the game changes.

export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(readonly seed: string) {
    this.a = hashString(seed + "#a");
    this.b = hashString(seed + "#b");
    this.c = hashString(seed + "#c");
    this.d = hashString(seed + "#d");
    for (let i = 0; i < 12; i++) this.nextUint();
  }

  /** sfc32 */
  nextUint(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Float in [0, 1). */
  next(): number {
    return this.nextUint() / 4294967296;
  }

  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("Rng.pick on empty list");
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** Picks by weight. Entries with weight <= 0 never win. */
  weighted<T extends { weight: number }>(entries: readonly T[]): T {
    const total = entries.reduce((s, e) => s + Math.max(0, e.weight), 0);
    if (total <= 0) throw new Error("Rng.weighted with no positive weights");
    let r = this.next() * total;
    for (const e of entries) {
      r -= Math.max(0, e.weight);
      if (r < 0) return e;
    }
    return entries[entries.length - 1] as T;
  }

  /** A new independent stream derived from this one's seed and a name. */
  fork(name: string): Rng {
    return new Rng(`${this.seed}/${name}`);
  }
}

export interface DiceRoll {
  total: number;
  rolls: number[];
  modifier: number;
}

const DICE = /^\s*(\d*)d(\d+)\s*(?:([+-])\s*(\d+))?\s*$/i;

export function parseDice(expr: string): { count: number; sides: number; modifier: number } {
  const flat = /^\s*(-?\d+)\s*$/.exec(expr);
  if (flat) return { count: 0, sides: 0, modifier: Number(flat[1]) };
  const m = DICE.exec(expr);
  if (!m) throw new Error(`Bad dice expression: "${expr}"`);
  const count = m[1] ? Number(m[1]) : 1;
  const sides = Number(m[2]);
  const modifier = m[4] ? Number(m[4]) * (m[3] === "-" ? -1 : 1) : 0;
  if (sides < 1 || count < 0) throw new Error(`Bad dice expression: "${expr}"`);
  return { count, sides, modifier };
}

/** Rolls "2d6+1"-style dice. `extraDice` adds dice (used for critical hits). */
export function rollDice(rng: Rng, expr: string, extraDice = 0): DiceRoll {
  const { count, sides, modifier } = parseDice(expr);
  const rolls: number[] = [];
  for (let i = 0; i < count + (count > 0 ? extraDice : 0); i++) rolls.push(rng.int(1, sides));
  return { total: rolls.reduce((s, r) => s + r, 0) + modifier, rolls, modifier };
}

export function averageDice(expr: string): number {
  const { count, sides, modifier } = parseDice(expr);
  return (count * (sides + 1)) / 2 + modifier;
}
