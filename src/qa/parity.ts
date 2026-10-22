// Engine parity dump. Produces exactly what engines/godot/dungeon-crawler/qa/parity.gd
// prints, using the engine-neutral core modules unchanged. tests/godot.test.ts
// compares the two, which is what keeps the Godot port from becoming a second
// hand-synced codebase: any drift fails the test.
import type { Bible } from "../bible/types";
import type { Vec2 } from "../core/contracts";
import type { GameDescription } from "../core/description";
import { Game } from "../core/game";
import type { GameEvents } from "../core/contracts";
import { generateLevel, tileAt, WALL, type Level } from "../core/level";
import { rollLoot } from "../core/loot";
import { hashString, parseDice, rollDice, Rng } from "../core/seeder";
import { botAction, playRun } from "./playtest";

export const PARITY_STREAMS = ["", "level:1", "combat:1", "loot:f1r2e0", "spawn:2:3", "spawn:2:3/item", "heal:it-1"];
const DICE = ["1d4+1", "2d6", "1d10+2", "4d4+8", "d8", "3d6-2", "7"];
const EVENTS: (keyof GameEvents)[] = [
  "enemyDefeated",
  "itemPickedUp",
  "inventoryChanged",
  "attack",
  "lootDropped",
  "playerHealthChanged",
  "floorChanged",
  "gameOver",
  "message",
];
const HASHES = ["", "a", "ashen-1", "playtest-0/loot:f1r1e0", "ünïcödé 🔥 seed", "日本語"];

export interface ParityOptions {
  rng: number;
  floors: number;
  turns: number;
  fullRuns: number;
}

const v2 = (p: Vec2) => ({ x: p.x, y: p.y });

function dumpRng(seed: string, bible: Bible, n: number) {
  const root = new Rng(seed);
  const streams: Record<string, number[]> = {};
  for (const name of PARITY_STREAMS) {
    let r = root;
    if (name) for (const part of name.split("/")) r = r.fork(part);
    streams[name] = Array.from({ length: n }, () => r.nextUint());
  }
  const r = root.fork("parity");
  const ints: number[] = [];
  for (let i = 0; i < n; i++) ints.push(r.int(1, 6), r.int(-5, 5), r.int(0, 1000000));
  const chances = Array.from({ length: n }, () => r.chance(0.45));
  const weighted: string[] = [];
  for (const table of Object.values(bible.lore.lootTables)) {
    const entries = [...table.entries, { item: "", weight: table.nothingWeight }];
    for (let i = 0; i < n; i++) weighted.push(r.weighted(entries).item);
  }
  const picks = Array.from({ length: n }, () => r.pick(["a", "b", "c", "d", "e"]));
  const dice: unknown[] = [];
  for (const expr of DICE) {
    for (let i = 0; i < 4; i++) {
      const roll = rollDice(r, expr);
      dice.push({ expr, total: roll.total, rolls: roll.rolls });
    }
    dice.push({ expr, crit: rollDice(r, expr, parseDice(expr).count).total });
  }
  const loot: unknown[] = [];
  for (const [id, table] of Object.entries(bible.lore.lootTables))
    for (let i = 0; i < 8; i++) loot.push(rollLoot(root.fork(`loot:${id}:${i}`), table, `${id}-${i}`));
  return { streams, ints, chances, weighted, picks, dice, loot };
}

function dumpLevel(l: Level) {
  const tiles: string[] = [];
  for (let y = 0; y < l.height; y++) {
    let row = "";
    for (let x = 0; x < l.width; x++) row += tileAt(l, x, y) === WALL ? "#" : ".";
    tiles.push(row);
  }
  return { width: l.width, height: l.height, tiles, rooms: l.rooms.map((r) => ({ ...r })), start: v2(l.start), stairs: v2(l.stairs) };
}

function dumpEntities(game: Game) {
  const s = game.state;
  return {
    enemies: s.enemies.map((e) => ({
      uid: e.uid,
      defId: e.defId,
      pos: v2(e.pos),
      hp: e.hp,
      maxHp: e.maxHp,
      ac: e.ac,
      attackBonus: e.attackBonus,
      damage: e.damage,
      sightRange: e.sightRange,
      awake: e.awake,
    })),
    ground: s.ground.map((g) => ({ uid: g.item.uid, itemId: g.item.itemId, pos: v2(g.pos) })),
  };
}

function dumpState(game: Game) {
  const s = game.state;
  const p = s.player;
  const inv = game.inventory;
  const equipped: Record<string, string> = {};
  if (inv.equipped.weapon) equipped.weapon = inv.equipped.weapon.uid;
  if (inv.equipped.armor) equipped.armor = inv.equipped.armor.uid;
  return {
    seed: s.seed,
    floor: s.floor,
    turn: s.turn,
    turnsOnFloor: s.turnsOnFloor,
    status: s.status,
    kills: s.kills,
    player: { pos: v2(p.pos), hp: p.hp, maxHp: p.maxHp, ac: p.ac, attackBonus: p.attackBonus, damage: p.damage, xp: p.xp, level: p.level, gold: p.gold },
    ...dumpEntities(game),
    inventory: { items: inv.items.map((i) => `${i.uid}:${i.itemId}`), equipped },
  };
}

export function parityDump(bible: Bible, desc: GameDescription, seeds: string[], opts: ParityOptions) {
  const hashes = Object.fromEntries(HASHES.map((s) => [s, hashString(s)]));
  const out: { hashes: Record<string, number>; seeds: Record<string, unknown>; fullRuns: unknown[] } = { hashes, seeds: {}, fullRuns: [] };
  for (const seed of seeds) {
    const root = new Rng(seed);
    const game = new Game(bible, desc, seed);
    // enterFloor is private in the core; parity reaches it the same way parity.gd calls enter_floor().
    const enterFloor = (f: number) => (game as unknown as { enterFloor(f: number): void }).enterFloor(f);
    const levels: unknown[] = [];
    const spawns: unknown[] = [];
    for (let f = 1; f <= opts.floors; f++) {
      levels.push(dumpLevel(generateLevel(root.fork(`level:${f}`), desc.level)));
      if (f > 1) enterFloor(f);
      spawns.push(dumpEntities(game));
    }
    const g = new Game(bible, desc, seed);
    const messages: string[] = [];
    const counts: Record<string, number> = {};
    for (const ev of EVENTS) {
      counts[ev] = 0;
      g.events.on(ev, (payload) => {
        counts[ev]!++;
        if (ev === "message") messages.push((payload as { text: string }).text);
      });
    }
    let actions = 0;
    while (g.state.status === "playing" && actions < opts.turns) {
      g.act(botAction(g));
      actions++;
    }
    out.seeds[seed] = {
      rng: dumpRng(seed, bible, opts.rng),
      levels,
      spawns,
      play: { actions, state: dumpState(g), messages, eventCounts: counts },
    };
  }
  for (let i = 0; i < opts.fullRuns; i++) out.fullRuns.push(playRun(bible, desc, `playtest-${i}`, []));
  return out;
}
