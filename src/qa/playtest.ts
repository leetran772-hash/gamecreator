// Automated playtesting: a bot plays seeded runs and flags crashes, softlocks
// and unreachable areas before any human plays.
import { Game, type Action } from "../core/game";
import { DIRS, distanceMap, FLOOR, type Level } from "../core/level";
import type { Vec2 } from "../core/contracts";
import type { Bible } from "../bible/types";
import type { GameDescription } from "../core/description";

export interface Issue {
  seed: string;
  floor: number;
  kind: "crash" | "softlock" | "unreachable";
  detail: string;
}

export interface RunResult {
  seed: string;
  outcome: "won" | "dead" | "softlock" | "crash";
  floor: number;
  turns: number;
  kills: number;
  gold: number;
  level: number;
}

/** Every floor tile, enemy, item and the stairs must be reachable from the start. */
export function checkReachability(game: Game): string[] {
  const s = game.state;
  const l = s.level;
  const dist = distanceMap(l, l.start);
  const reach = (p: Vec2) => (dist[p.y * l.width + p.x] as number) >= 0;
  const problems: string[] = [];
  if (!reach(l.stairs)) problems.push(`stairs at ${l.stairs.x},${l.stairs.y} unreachable`);
  for (const e of s.enemies) if (!reach(e.pos)) problems.push(`enemy ${e.uid} unreachable`);
  for (const g of s.ground) if (!reach(g.pos)) problems.push(`item ${g.item.uid} unreachable`);
  let islands = 0;
  for (let i = 0; i < l.tiles.length; i++) if (l.tiles[i] === FLOOR && (dist[i] as number) < 0) islands++;
  if (islands) problems.push(`${islands} floor tiles unreachable`);
  return problems;
}

/** Simple but competent policy: heal when low, gear up, clear, descend. */
export function botAction(game: Game): Action {
  const s = game.state;
  const p = s.player;
  const inv = game.inventory;
  const potions = inv.items.filter((i) => game.item(i.itemId).kind === "potion");
  if (p.hp <= p.maxHp * 0.4 && potions.length) return { type: "use", uid: potions[0]!.uid };

  // Equip anything strictly better.
  for (const inst of inv.items) {
    const it = game.item(inst.itemId);
    if (it.kind === "weapon") {
      const cur = inv.equipped.weapon && game.item(inv.equipped.weapon.itemId);
      if (!cur || score(it.stats) > score(cur.stats)) return { type: "use", uid: inst.uid };
    }
    if (it.kind === "armor") {
      const cur = inv.equipped.armor && game.item(inv.equipped.armor.itemId);
      if ((it.stats.armorClass ?? 0) > (cur?.stats.armorClass ?? 0)) return { type: "use", uid: inst.uid };
    }
  }

  for (const d of DIRS) if (game.enemyAt(p.pos.x + d.x, p.pos.y + d.y)) return { type: "move", dx: d.x, dy: d.y };

  const onStairs = p.pos.x === s.level.stairs.x && p.pos.y === s.level.stairs.y;
  const goals: Vec2[] = [...s.enemies.map((e) => e.pos), ...(inv.full ? [] : s.ground.map((g) => g.pos))];
  if (!goals.length) return onStairs ? { type: "descend" } : stepToward(game, s.level.stairs);
  return stepTowardNearest(game, goals) ?? (onStairs ? { type: "descend" } : stepToward(game, s.level.stairs));
}

function score(stats: { attackBonus?: number; damage?: string }) {
  const m = /^(\d*)d(\d+)(?:\+(\d+))?/.exec(stats.damage ?? "1d1");
  const avg = m ? (Number(m[1] || 1) * (Number(m[2]) + 1)) / 2 + Number(m[3] ?? 0) : 0;
  return avg + (stats.attackBonus ?? 0) * 0.5;
}

function stepTowardNearest(game: Game, goals: Vec2[]): Action | undefined {
  const s = game.state;
  const l = s.level;
  // Distance from the player; enemies block except goal tiles.
  const goalSet = new Set(goals.map((g) => g.y * l.width + g.x));
  const dist = distanceMap(l, s.player.pos, (x, y) => !!game.enemyAt(x, y) && !goalSet.has(y * l.width + x));
  let target: Vec2 | undefined;
  let best = Infinity;
  for (const g of goals) {
    const d = dist[g.y * l.width + g.x] as number;
    if (d > 0 && d < best) {
      best = d;
      target = g;
    }
  }
  return target ? stepToward(game, target) : undefined;
}

function stepToward(game: Game, target: Vec2): Action {
  const s = game.state;
  const l: Level = s.level;
  const dist = distanceMap(l, target, (x, y) => !!game.enemyAt(x, y) && !(x === target.x && y === target.y));
  let bestDir = DIRS[0]!;
  let best = Infinity;
  for (const d of DIRS) {
    const nx = s.player.pos.x + d.x;
    const ny = s.player.pos.y + d.y;
    const v = dist[ny * l.width + nx];
    if (v !== undefined && v >= 0 && v < best && nx >= 0 && ny >= 0 && nx < l.width && ny < l.height) {
      best = v;
      bestDir = d;
    }
  }
  return best === Infinity ? { type: "wait" } : { type: "move", dx: bestDir.x, dy: bestDir.y };
}

export function playRun(bible: Bible, desc: GameDescription, seed: string, issues: Issue[]): RunResult {
  let game: Game | undefined;
  let floorChecked = 0;
  try {
    game = new Game(bible, desc, seed);
    let idle = 0;
    while (game.state.status === "playing") {
      const s = game.state;
      if (floorChecked !== s.floor) {
        floorChecked = s.floor;
        for (const detail of checkReachability(game)) issues.push({ seed, floor: s.floor, kind: "unreachable", detail });
      }
      if (s.turnsOnFloor > desc.qa.maxTurnsPerFloor) {
        issues.push({ seed, floor: s.floor, kind: "softlock", detail: `no progress after ${s.turnsOnFloor} turns` });
        return result(game, seed, "softlock");
      }
      const acted = game.act(botAction(game));
      idle = acted ? 0 : idle + 1;
      if (idle > 20) {
        issues.push({ seed, floor: s.floor, kind: "softlock", detail: "bot has no valid action" });
        return result(game, seed, "softlock");
      }
    }
    return result(game, seed, game.state.status as "won" | "dead");
  } catch (err) {
    issues.push({ seed, floor: game?.state.floor ?? 0, kind: "crash", detail: String((err as Error).stack ?? err) });
    return { seed, outcome: "crash", floor: game?.state.floor ?? 0, turns: game?.state.turn ?? 0, kills: 0, gold: 0, level: 1 };
  }
}

function result(game: Game, seed: string, outcome: RunResult["outcome"]): RunResult {
  const s = game.state;
  return { seed, outcome, floor: s.floor, turns: s.turn, kills: s.kills, gold: s.player.gold, level: s.player.level };
}

export function playtest(bible: Bible, desc: GameDescription, runs = desc.qa.playtestRuns) {
  const issues: Issue[] = [];
  const results: RunResult[] = [];
  for (let i = 0; i < runs; i++) results.push(playRun(bible, desc, `playtest-${i}`, issues));
  const won = results.filter((r) => r.outcome === "won").length;
  const deathsByFloor: Record<number, number> = {};
  for (const r of results) if (r.outcome === "dead") deathsByFloor[r.floor] = (deathsByFloor[r.floor] ?? 0) + 1;
  return { results, issues, winRate: won / runs, deathsByFloor };
}
