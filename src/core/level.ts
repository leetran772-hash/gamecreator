// Level design module: seeded room-and-corridor dungeons.
import type { Vec2 } from "./contracts";
import type { Rng } from "./seeder";

export const WALL = 0;
export const FLOOR = 1;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LevelOptions {
  width: number;
  height: number;
  roomAttempts: number;
  minRooms: number;
  maxRooms: number;
  minRoomSize: number;
  maxRoomSize: number;
}

export interface Level {
  width: number;
  height: number;
  tiles: Uint8Array;
  rooms: Rect[];
  start: Vec2;
  stairs: Vec2;
}

export const tileAt = (l: Level, x: number, y: number): number =>
  x < 0 || y < 0 || x >= l.width || y >= l.height ? WALL : (l.tiles[y * l.width + x] as number);

export const isFloor = (l: Level, x: number, y: number) => tileAt(l, x, y) === FLOOR;

export const roomCenter = (r: Rect): Vec2 => ({ x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) });

const overlaps = (a: Rect, b: Rect, pad: number) =>
  a.x - pad < b.x + b.w && a.x + a.w + pad > b.x && a.y - pad < b.y + b.h && a.y + a.h + pad > b.y;

export const DIRS: readonly Vec2[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

/** Breadth-first distances from `from` over floor tiles (-1 = unreachable). */
export function distanceMap(l: Level, from: Vec2, blocked?: (x: number, y: number) => boolean): Int32Array {
  const dist = new Int32Array(l.width * l.height).fill(-1);
  if (!isFloor(l, from.x, from.y)) return dist;
  const queue = [from.y * l.width + from.x];
  dist[queue[0] as number] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const i = queue[qi] as number;
    const x = i % l.width;
    const y = (i - x) / l.width;
    for (const d of DIRS) {
      const nx = x + d.x;
      const ny = y + d.y;
      if (!isFloor(l, nx, ny)) continue;
      const ni = ny * l.width + nx;
      if (dist[ni] !== -1) continue;
      if (blocked?.(nx, ny)) continue;
      dist[ni] = (dist[i] as number) + 1;
      queue.push(ni);
    }
  }
  return dist;
}

export function generateLevel(rng: Rng, o: LevelOptions): Level {
  const tiles = new Uint8Array(o.width * o.height);
  const rooms: Rect[] = [];
  for (let i = 0; i < o.roomAttempts && rooms.length < o.maxRooms; i++) {
    const w = rng.int(o.minRoomSize, o.maxRoomSize);
    const h = rng.int(o.minRoomSize, o.maxRoomSize);
    const r = { x: rng.int(1, o.width - w - 2), y: rng.int(1, o.height - h - 2), w, h };
    if (rooms.some((other) => overlaps(r, other, 1))) continue;
    rooms.push(r);
  }
  if (rooms.length < o.minRooms) {
    throw new Error(`Level generator placed ${rooms.length} rooms, needs ${o.minRooms}; map too small?`);
  }
  const carve = (x: number, y: number) => {
    tiles[y * o.width + x] = FLOOR;
  };
  for (const r of rooms) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) carve(x, y);

  // Connect rooms in left-to-right order with L-shaped corridors, plus one extra loop.
  const order = [...rooms].sort((a, b) => roomCenter(a).x - roomCenter(b).x);
  const corridor = (a: Vec2, b: Vec2) => {
    const horizontalFirst = rng.chance(0.5);
    const corner = horizontalFirst ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
    for (const [p, q] of [
      [a, corner],
      [corner, b],
    ] as const) {
      for (let x = Math.min(p.x, q.x); x <= Math.max(p.x, q.x); x++) carve(x, p.y);
      for (let y = Math.min(p.y, q.y); y <= Math.max(p.y, q.y); y++) carve(q.x, y);
    }
  };
  for (let i = 1; i < order.length; i++) corridor(roomCenter(order[i - 1]!), roomCenter(order[i]!));
  if (order.length > 3) corridor(roomCenter(order[0]!), roomCenter(order[Math.floor(order.length / 2) + 1]!));

  const level: Level = { width: o.width, height: o.height, tiles, rooms: order, start: roomCenter(order[0]!), stairs: { x: 0, y: 0 } };
  // Stairs go in the room farthest (by walking distance) from the start.
  const dist = distanceMap(level, level.start);
  let best = order[order.length - 1]!;
  let bestD = -1;
  for (const r of order) {
    const c = roomCenter(r);
    const d = dist[c.y * o.width + c.x] as number;
    if (d > bestD) {
      bestD = d;
      best = r;
    }
  }
  level.stairs = roomCenter(best);
  return level;
}
