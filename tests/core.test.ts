import { describe, expect, it } from "vitest";
import { averageDice, parseDice, rollDice, Rng } from "../src/core/seeder";
import { hitChance, resolveAttack } from "../src/core/combat";
import { rollLoot } from "../src/core/loot";
import { Inventory } from "../src/core/inventory";
import { distanceMap, FLOOR, generateLevel } from "../src/core/level";
import { Game } from "../src/core/game";
import { validateBible } from "../src/bible/validate";
import { bible, description } from "../projects/dungeon-crawler/index";

describe("seeder", () => {
  it("is deterministic per seed", () => {
    const a = new Rng("x");
    const b = new Rng("x");
    expect(Array.from({ length: 5 }, () => a.next())).toEqual(Array.from({ length: 5 }, () => b.next()));
    expect(new Rng("x").next()).not.toEqual(new Rng("y").next());
  });

  it("sub-streams are independent of how much other streams were used", () => {
    const main1 = new Rng("run");
    const main2 = new Rng("run");
    for (let i = 0; i < 100; i++) main2.fork("combat").next();
    main2.next();
    expect(main1.fork("loot").next()).toEqual(main2.fork("loot").next());
  });

  it("int stays in range and covers it", () => {
    const r = new Rng("range");
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = r.int(1, 6);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
      seen.add(v);
    }
    expect(seen.size).toBe(6);
  });

  it("parses and rolls dice", () => {
    expect(parseDice("2d6+3")).toEqual({ count: 2, sides: 6, modifier: 3 });
    expect(parseDice("d20")).toEqual({ count: 1, sides: 20, modifier: 0 });
    expect(parseDice("1d4-1")).toEqual({ count: 1, sides: 4, modifier: -1 });
    expect(parseDice("5")).toEqual({ count: 0, sides: 0, modifier: 5 });
    expect(() => parseDice("banana")).toThrow();
    expect(averageDice("2d6+1")).toBe(8);
    const r = new Rng("dice");
    for (let i = 0; i < 500; i++) {
      const t = rollDice(r, "2d6+1").total;
      expect(t).toBeGreaterThanOrEqual(3);
      expect(t).toBeLessThanOrEqual(13);
    }
  });
});

describe("combat", () => {
  const hero = { name: "h", ac: 12, attackBonus: 3, damage: "1d6" };
  it("nat 20 always hits, nat 1 always misses", () => {
    const tank = { ...hero, ac: 99 };
    const weak = { ...hero, attackBonus: 50 };
    const r = new Rng("combat");
    for (let i = 0; i < 3000; i++) {
      const a = resolveAttack(r, hero, tank);
      expect(a.hit).toBe(a.roll === 20);
      const b = resolveAttack(r, weak, hero);
      expect(b.hit).toBe(b.roll !== 1);
      if (a.crit) expect(a.damage).toBeLessThanOrEqual(12);
    }
    expect(hitChance(hero, tank)).toBe(0.05);
    expect(hitChance(weak, hero)).toBe(0.95);
    expect(hitChance(hero, { ...hero, ac: 13 })).toBe(0.55);
  });
});

describe("loot roller", () => {
  it("drops depend only on the keyed stream", () => {
    const table = bible.lore.lootTables.cult!;
    const a = rollLoot(new Rng("s").fork("loot:enemy-7"), table, "p");
    const b = rollLoot(new Rng("s").fork("loot:enemy-7"), table, "p");
    expect(a).toEqual(b);
  });
});

describe("inventory", () => {
  it("adds, equips and swaps, emitting changes", () => {
    const changes: number[] = [];
    const inv = new Inventory(2, (id) => bible.lore.items[id]!, (s) => changes.push(s.items.length));
    expect(inv.add({ uid: "a", itemId: "dagger" })).toBe(true);
    expect(inv.add({ uid: "b", itemId: "shortsword" })).toBe(true);
    expect(inv.add({ uid: "c", itemId: "potion" })).toBe(false);
    expect(inv.equip("a")).toBe(true);
    expect(inv.equip("b")).toBe(true);
    expect(inv.equipped.weapon?.uid).toBe("b");
    expect(inv.items.map((i) => i.uid)).toEqual(["a"]);
    expect(changes.length).toBe(4);
  });
});

describe("level design", () => {
  it("every floor tile is connected for many seeds", () => {
    for (let i = 0; i < 300; i++) {
      const l = generateLevel(new Rng(`lvl-${i}`), description.level);
      const dist = distanceMap(l, l.start);
      for (let t = 0; t < l.tiles.length; t++) if (l.tiles[t] === FLOOR) expect(dist[t]).toBeGreaterThanOrEqual(0);
      expect(l.rooms.length).toBeGreaterThanOrEqual(description.level.minRooms);
    }
  });
});

describe("game", () => {
  const replay = (seed: string) => {
    const g = new Game(bible, description, seed);
    const moves = [
      { type: "move", dx: 1, dy: 0 },
      { type: "move", dx: 0, dy: 1 },
      { type: "move", dx: -1, dy: 0 },
      { type: "move", dx: 0, dy: -1 },
    ] as const;
    for (let i = 0; i < 300; i++) g.act(moves[(i * 7) % 4]!);
    return JSON.stringify({ p: g.state.player, e: g.state.enemies, ground: g.state.ground });
  };

  it("replays identically from the same seed", () => {
    expect(replay("det")).toEqual(replay("det"));
    expect(replay("det")).not.toEqual(replay("other"));
  });

  it("flows enemyDefeated -> loot -> itemPickedUp -> inventoryChanged", () => {
    for (let i = 0; i < 50; i++) {
      const g = new Game(bible, description, `flow-${i}`);
      const p = g.state.player.pos;
      const dir = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }].find(
        (d) => g.state.level.tiles[(p.y + d.y) * g.state.level.width + p.x + d.x] === 1 && !g.enemyAt(p.x + d.x, p.y + d.y),
      )!;
      const target = { x: p.x + dir.x, y: p.y + dir.y };
      g.state.ground = [];
      const seen: string[] = [];
      for (const k of ["lootDropped", "itemPickedUp", "inventoryChanged"] as const) g.events.on(k, () => seen.push(k));
      g.events.emit("enemyDefeated", { enemyUid: "test", enemyId: "cultist", floor: 1, position: target, xp: 0 });
      const drops = g.state.ground.length;
      if (!drops) continue;
      g.act({ type: "move", dx: dir.x, dy: dir.y });
      expect(seen.filter((s) => s === "lootDropped").length).toBe(drops);
      expect(seen.filter((s) => s === "itemPickedUp").length).toBe(drops);
      expect(g.state.ground.length).toBe(0);
      return;
    }
    throw new Error("no seed dropped loot");
  });

  it("starting bible is valid", () => {
    expect(validateBible(bible)).toEqual([]);
  });

  it("validator catches broken references", () => {
    const broken = structuredClone(bible);
    broken.lore.bestiary.rat!.lootTable = "nope";
    broken.visual.materials.floor!.color = "pink";
    expect(validateBible(broken).length).toBe(2);
  });
});
