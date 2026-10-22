import { deflateSync } from "node:zlib";
// Writes a tiny valid GLB box. Used by dry runs so the rest of the pipeline
// (Blender cleanup, engine loading) can be exercised without API spend.
export interface BoxOptions {
  /** Moves the vertices (e.g. [0, 0.5, 0] makes a floating box). */
  offset?: [number, number, number];
  /** Adds an untextured material with this linear RGBA baseColorFactor. */
  baseColor?: [number, number, number, number];
  /** Node transform applied on top of the vertices. */
  translation?: [number, number, number];
  scale?: [number, number, number];
}

export function boxGlb(w = 1, h = 1.8, d = 0.6, opts: BoxOptions = {}): Uint8Array {
  const x = w / 2;
  const z = d / 2;
  const [ox, oy, oz] = opts.offset ?? [0, 0, 0];
  const pos = new Float32Array([-x, 0, -z, x, 0, -z, x, h, -z, -x, h, -z, -x, 0, z, x, 0, z, x, h, z, -x, h, z]);
  for (let i = 0; i < pos.length; i += 3) {
    pos[i]! += ox;
    pos[i + 1]! += oy;
    pos[i + 2]! += oz;
  }
  const idx = new Uint16Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]);
  const bin = new Uint8Array(pos.byteLength + idx.byteLength + ((4 - (idx.byteLength % 4)) % 4));
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(new Uint8Array(idx.buffer), pos.byteLength);
  const gltf = {
    asset: { version: "2.0", generator: "gamecreator placeholder" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "placeholder", ...(opts.translation ? { translation: opts.translation } : {}), ...(opts.scale ? { scale: opts.scale } : {}) }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, ...(opts.baseColor ? { material: 0 } : {}) }] }],
    ...(opts.baseColor ? { materials: [{ name: "base", pbrMetallicRoughness: { baseColorFactor: opts.baseColor } }] } : {}),
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: "VEC3", min: [-x + ox, oy, -z + oz], max: [x + ox, h + oy, z + oz] },
      { bufferView: 1, componentType: 5123, count: idx.length, type: "SCALAR" },
    ],
  };
  let json = new TextEncoder().encode(JSON.stringify(gltf));
  const pad = (4 - (json.length % 4)) % 4;
  if (pad) json = new Uint8Array([...json, ...new Array(pad).fill(0x20)]);
  const total = 12 + 8 + json.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, total, true);
  v.setUint32(12, json.length, true);
  v.setUint32(16, 0x4e4f534a, true);
  out.set(json, 20);
  const o = 20 + json.length;
  v.setUint32(o, bin.length, true);
  v.setUint32(o + 4, 0x004e4942, true);
  out.set(bin, o + 8);
  return out;
}

/**
 * A visible placeholder image for dry runs: a soft rounded silhouette on a
 * neutral background, tinted by `seed` so different subjects look different.
 */
export function placeholderPng(seed = "placeholder", size = 256): Uint8Array {
  let hsh = 2166136261;
  for (let i = 0; i < seed.length; i++) hsh = Math.imul(hsh ^ seed.charCodeAt(i), 16777619) >>> 0;
  const hue = (hsh % 360) / 360;
  const [r, g, b] = hslToRgb(hue, 0.45, 0.55);
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const u = (x - size / 2) / (size * 0.28);
      const v = (y - size * 0.55) / (size * 0.36);
      const head = Math.hypot((x - size / 2) / (size * 0.14), (y - size * 0.26) / (size * 0.14));
      const inside = u * u + v * v < 1 || head < 1;
      const o = y * (size * 3 + 1) + 1 + x * 3;
      const bg = 0xd8 - Math.floor((y / size) * 24);
      raw[o] = inside ? r : bg;
      raw[o + 1] = inside ? g : bg;
      raw[o + 2] = inside ? b : bg;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return new Uint8Array(
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]),
  );
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255);
  };
  return [f(0), f(8), f(4)];
}

let CRC_TABLE: Uint32Array | undefined;
function crc32(buf: Buffer): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Placeholder image for dry-run concepts and tests. */
export const PLACEHOLDER_PNG = placeholderPng();
