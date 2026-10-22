// Writes a tiny valid GLB box. Used by dry runs so the rest of the pipeline
// (Blender cleanup, engine loading) can be exercised without API spend.
export function boxGlb(w = 1, h = 1.8, d = 0.6): Uint8Array {
  const x = w / 2;
  const z = d / 2;
  const pos = new Float32Array([-x, 0, -z, x, 0, -z, x, h, -z, -x, h, -z, -x, 0, z, x, 0, z, x, h, z, -x, h, z]);
  const idx = new Uint16Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]);
  const bin = new Uint8Array(pos.byteLength + idx.byteLength + ((4 - (idx.byteLength % 4)) % 4));
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(new Uint8Array(idx.buffer), pos.byteLength);
  const gltf = {
    asset: { version: "2.0", generator: "gamecreator placeholder" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "placeholder" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: "VEC3", min: [-x, 0, -z], max: [x, h, z] },
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

/** 1x1 grey PNG for dry-run concepts. */
export const PLACEHOLDER_PNG = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN4+P//fwAJIAPfaxNz2QAAAABJRU5ErkJggg==", "base64"),
);
