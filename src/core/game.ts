// Engine-neutral turn-based dungeon crawler. Wires seeder + level design +
// combat + loot roller + inventory together through shared events. Engines only
// read `state`, call `act()`, and listen to `events`.
import { resolveAttack, type Combatant } from "./combat";
import type { GameEvents, Item, ItemInstance, Vec2 } from "./contracts";
import type { GameDescription } from "./description";
import { EventBus } from "./events";
import { Inventory } from "./inventory";
import { DIRS, distanceMap, generateLevel, isFloor, type Level } from "./level";
import { rollLoot } from "./loot";
import { rollDice, Rng } from "./seeder";
import type { Bible, EnemyDef } from "../bible/types";

export interface Actor {
  uid: string;
  defId: string;
  name: string;
  pos: Vec2;
  hp: number;
  maxHp: number;
  ac: number;
  attackBonus: number;
  damage: string;
  sightRange: number;
  awake: boolean;
}

export interface GroundItem {
  item: ItemInstance;
  pos: Vec2;
}

export type Action =
  | { type: "move"; dx: number; dy: number }
  | { type: "wait" }
  | { type: "use"; uid: string }
  | { type: "descend" };

export interface PlayerState extends Actor {
  xp: number;
  level: number;
  gold: number;
}

export interface GameState {
  seed: string;
  floor: number;
  turn: number;
  turnsOnFloor: number;
  level: Level;
  player: PlayerState;
  enemies: Actor[];
  ground: GroundItem[];
  status: "playing" | "dead" | "won";
  kills: number;
}

export class Game {
  readonly events = new EventBus<GameEvents>();
  readonly rng: Rng;
  readonly inventory: Inventory;
  state: GameState;
  private combatRng!: Rng;
  private nextItemUid = 0;

  constructor(
    readonly bible: Bible,
    readonly desc: GameDescription,
    seed: string = desc.defaultSeed,
  ) {
    this.rng = new Rng(seed);
    this.inventory = new Inventory(desc.player.inventoryCapacity, (id) => this.item(id), (snap) =>
      this.events.emit("inventoryChanged", snap),
    );
    const p = bible.lore.player;
    const player: PlayerState = {
      uid: "player",
      defId: "player",
      name: p.name,
      pos: { x: 0, y: 0 },
      hp: p.hp,
      maxHp: p.hp,
      ac: p.ac,
      attackBonus: p.attackBonus,
      damage: p.damage,
      sightRange: 0,
      awake: true,
      xp: 0,
      level: 1,
      gold: 0,
    };
    this.state = {
      seed,
      floor: 0,
      turn: 0,
      turnsOnFloor: 0,
      level: undefined as unknown as Level,
      player,
      enemies: [],
      ground: [],
      status: "playing",
      kills: 0,
    };

    // Loot roller listens to combat.
    this.events.on("enemyDefeated", (e) => {
      const def = this.bible.lore.bestiary[e.enemyId];
      const table = def && this.bible.lore.lootTables[def.lootTable];
      if (!table) return;
      for (const item of rollLoot(this.rng.fork(`loot:${e.enemyUid}`), table, `loot-${e.enemyUid}`)) {
        this.state.ground.push({ item, pos: { ...e.position } });
        this.events.emit("lootDropped", { item, position: e.position, sourceUid: e.enemyUid });
      }
    });
    // Inventory receives pickups.
    this.events.on("itemPickedUp", (e) => {
      const it = this.item(e.item.itemId);
      if (it.kind === "treasure") {
        this.state.player.gold += it.stats.value ?? 0;
        this.say(`You pocket ${it.name} (+${it.stats.value ?? 0} gold).`);
        return;
      }
      this.inventory.add(e.item);
      this.say(`You pick up ${it.name}.`);
    });

    for (const id of desc.player.startingItems) {
      const inst = this.newItem(id);
      this.inventory.add(inst);
      if (this.item(id).kind === "weapon" || this.item(id).kind === "armor") this.inventory.equip(inst.uid);
    }
    this.applyEquipment();
    this.enterFloor(1);
  }

  item(id: string): Item {
    const it = this.bible.lore.items[id];
    if (!it) throw new Error(`Unknown item "${id}"`);
    return it;
  }

  /** Current player combat stats including equipment. */
  get playerCombatant(): Combatant {
    return this.state.player;
  }

  act(action: Action): boolean {
    if (this.state.status !== "playing") return false;
    const floorBefore = this.state.floor;
    const used = this.playerAct(action);
    if (!used) return false;
    // Arriving on a new floor gives the player a free turn (no hit on arrival).
    if (this.state.status === "playing" && this.state.floor === floorBefore) this.enemiesAct();
    this.state.turn++;
    this.state.turnsOnFloor++;
    return true;
  }

  enemyAt(x: number, y: number): Actor | undefined {
    return this.state.enemies.find((e) => e.pos.x === x && e.pos.y === y);
  }

  private playerAct(action: Action): boolean {
    const s = this.state;
    const p = s.player;
    switch (action.type) {
      case "wait":
        return true;
      case "descend": {
        if (p.pos.x !== s.level.stairs.x || p.pos.y !== s.level.stairs.y) return false;
        if (s.floor >= this.desc.floors) {
          s.status = "won";
          this.say("You escape the depths!");
          this.events.emit("gameOver", { won: true, floor: s.floor, turn: s.turn });
        } else {
          this.enterFloor(s.floor + 1);
        }
        return true;
      }
      case "use":
        return this.useItem(action.uid);
      case "move": {
        const nx = p.pos.x + Math.sign(action.dx);
        const ny = p.pos.y + Math.sign(action.dy);
        if (Math.abs(nx - p.pos.x) + Math.abs(ny - p.pos.y) !== 1) return false;
        const enemy = this.enemyAt(nx, ny);
        if (enemy) {
          this.attack(p, enemy);
          return true;
        }
        if (!isFloor(s.level, nx, ny)) return false;
        p.pos = { x: nx, y: ny };
        this.pickUpAt(p.pos);
        return true;
      }
    }
  }

  private useItem(uid: string): boolean {
    const inst = this.inventory.items.find((i) => i.uid === uid);
    if (!inst) return false;
    const it = this.item(inst.itemId);
    const p = this.state.player;
    if (it.kind === "potion" && it.stats.heal) {
      if (p.hp >= p.maxHp) {
        this.say("You're already at full health.");
        return false;
      }
      const healed = Math.min(p.maxHp - p.hp, rollDice(this.rng.fork(`heal:${uid}`), it.stats.heal).total);
      p.hp += healed;
      this.inventory.remove(uid);
      this.say(`You drink ${it.name} and recover ${healed} HP.`);
      this.events.emit("playerHealthChanged", { hp: p.hp, maxHp: p.maxHp });
      return true;
    }
    if (this.inventory.equip(uid)) {
      this.applyEquipment();
      this.say(`You equip ${it.name}.`);
      return true;
    }
    return false;
  }

  private applyEquipment() {
    const base = this.bible.lore.player;
    const p = this.state.player;
    const w = this.inventory.equipped.weapon && this.item(this.inventory.equipped.weapon.itemId);
    const a = this.inventory.equipped.armor && this.item(this.inventory.equipped.armor.itemId);
    p.damage = w?.stats.damage ?? base.damage;
    p.attackBonus = base.attackBonus + (p.level - 1) + (w?.stats.attackBonus ?? 0);
    p.ac = a?.stats.armorClass ?? base.ac;
  }

  private pickUpAt(pos: Vec2) {
    const here = this.state.ground.filter((g) => g.pos.x === pos.x && g.pos.y === pos.y);
    for (const g of here) {
      const it = this.item(g.item.itemId);
      if (it.kind !== "treasure" && this.inventory.full) {
        this.say(`Your pack is full; you leave ${it.name}.`);
        continue;
      }
      this.state.ground.splice(this.state.ground.indexOf(g), 1);
      this.events.emit("itemPickedUp", { item: g.item, position: { ...pos } });
    }
  }

  private attack(attacker: Actor, defender: Actor) {
    const r = resolveAttack(this.combatRng, attacker, defender);
    this.events.emit("attack", { attacker: attacker.uid, defender: defender.uid, ...r });
    if (r.hit) defender.hp -= r.damage;
    const verb = r.crit ? "CRITS" : r.hit ? "hits" : "misses";
    this.say(`${attacker.name} ${verb} ${defender.name}${r.hit ? ` for ${r.damage}` : ""} (${r.roll}+${attacker.attackBonus} vs AC ${defender.ac}).`);
    const s = this.state;
    if (defender.uid === "player") {
      this.events.emit("playerHealthChanged", { hp: Math.max(0, defender.hp), maxHp: defender.maxHp });
      if (defender.hp <= 0) {
        s.status = "dead";
        this.say("You die.");
        this.events.emit("gameOver", { won: false, floor: s.floor, turn: s.turn });
      }
      return;
    }
    if (defender.hp <= 0) {
      s.enemies = s.enemies.filter((e) => e !== defender);
      s.kills++;
      const def = this.bible.lore.bestiary[defender.defId] as EnemyDef;
      this.events.emit("enemyDefeated", {
        enemyUid: defender.uid,
        enemyId: defender.defId,
        floor: s.floor,
        position: { ...defender.pos },
        xp: def.xp,
      });
      this.gainXp(def.xp);
    }
  }

  private gainXp(xp: number) {
    const p = this.state.player;
    p.xp += xp;
    while (p.xp >= p.level * this.desc.player.xpPerLevel) {
      p.level++;
      p.maxHp += this.desc.player.hpPerLevel;
      p.hp += this.desc.player.hpPerLevel;
      this.applyEquipment();
      this.say(`You reach level ${p.level}!`);
      this.events.emit("playerHealthChanged", { hp: p.hp, maxHp: p.maxHp });
    }
  }

  private enemiesAct() {
    const s = this.state;
    const p = s.player;
    // One distance map from the player, ignoring enemies, drives every chaser.
    const dist = distanceMap(s.level, p.pos);
    const w = s.level.width;
    for (const e of [...s.enemies]) {
      if (s.status !== "playing") return;
      const d = Math.abs(e.pos.x - p.pos.x) + Math.abs(e.pos.y - p.pos.y);
      if (d === 1) {
        e.awake = true;
        this.attack(e, p);
        continue;
      }
      const pathD = dist[e.pos.y * w + e.pos.x] as number;
      if (!e.awake && pathD >= 0 && pathD <= e.sightRange) e.awake = true;
      if (!e.awake) continue;
      let best: Vec2 | undefined;
      let bestD = pathD < 0 ? Infinity : pathD;
      for (const dir of DIRS) {
        const nx = e.pos.x + dir.x;
        const ny = e.pos.y + dir.y;
        const nd = dist[ny * w + nx];
        if (nd === undefined || nd < 0 || !isFloor(s.level, nx, ny)) continue;
        if (nd < bestD && !this.enemyAt(nx, ny) && !(nx === p.pos.x && ny === p.pos.y)) {
          bestD = nd;
          best = { x: nx, y: ny };
        }
      }
      if (best) e.pos = best;
    }
  }

  private newItem(itemId: string, prefix = "it"): ItemInstance {
    return { uid: `${prefix}-${this.nextItemUid++}`, itemId };
  }

  private enterFloor(floor: number) {
    const s = this.state;
    s.floor = floor;
    s.turnsOnFloor = 0;
    s.level = generateLevel(this.rng.fork(`level:${floor}`), this.desc.level);
    this.combatRng = this.rng.fork(`combat:${floor}`);
    s.player.pos = { ...s.level.start };
    s.enemies = [];
    s.ground = [];

    const bestiary = Object.values(this.bible.lore.bestiary).filter((e) => e.minFloor <= floor);
    const [minE, maxE] = this.desc.spawns.enemiesPerRoom;
    const occupied = new Set([`${s.level.start.x},${s.level.start.y}`, `${s.level.stairs.x},${s.level.stairs.y}`]);
    s.level.rooms.forEach((room, ri) => {
      // Each room has its own stream: changing one room's spawns leaves the others alone.
      const rr = this.rng.fork(`spawn:${floor}:${ri}`);
      const freeTile = (): Vec2 | undefined => {
        for (let tries = 0; tries < 30; tries++) {
          const pos = { x: rr.int(room.x, room.x + room.w - 1), y: rr.int(room.y, room.y + room.h - 1) };
          if (!occupied.has(`${pos.x},${pos.y}`)) {
            occupied.add(`${pos.x},${pos.y}`);
            return pos;
          }
        }
        return undefined;
      };
      if (ri > 0) {
        const n = rr.int(minE, maxE + Math.floor((floor - 1) / 2));
        for (let i = 0; i < n; i++) {
          const def = rr.weighted(bestiary.map((d) => ({ ...d, weight: d.spawnWeight })));
          const pos = freeTile();
          if (!pos) continue;
          s.enemies.push({
            uid: `f${floor}r${ri}e${i}`,
            defId: def.id,
            name: def.name,
            pos,
            hp: def.hp,
            maxHp: def.hp,
            ac: def.ac,
            attackBonus: def.attackBonus,
            damage: def.damage,
            sightRange: def.sightRange,
            awake: false,
          });
        }
      }
      if (rr.chance(this.desc.spawns.itemChancePerRoom)) {
        const table = this.bible.lore.lootTables[this.desc.spawns.floorItemTable];
        const pos = freeTile();
        if (table && pos) {
          for (const item of rollLoot(rr.fork("item"), table, `f${floor}r${ri}`)) s.ground.push({ item, pos });
        }
      }
    });
    this.say(floor === 1 ? `You enter ${this.bible.meta.title}.` : `You descend to floor ${floor}.`);
    this.events.emit("floorChanged", { floor });
  }

  private say(text: string) {
    this.events.emit("message", { text });
  }
}
