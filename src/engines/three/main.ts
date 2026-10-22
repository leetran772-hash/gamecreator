// Three.js preview. Reads state from the engine-neutral core, renders it, and
// forwards input as core actions. Uses cleaned GLBs from the asset pipeline
// when the bible points at them, otherwise simple primitives.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { Game, type Action } from "../../core/game";
import { WALL, tileAt } from "../../core/level";
import { botAction } from "../../qa/playtest";
import { Animator } from "./animation";
import { GameAudio } from "./audio";
import { Hud } from "./hud";
import { loadProjectData, projectNames } from "./projectData";

const params = new URLSearchParams(location.search);
const names = projectNames();
const projectName = params.get("project") ?? (names.includes("dungeon-crawler") ? "dungeon-crawler" : names[0]!);
const project = loadProjectData(projectName);
const { bible, description } = project;
let seed = params.get("seed") ?? description.defaultSeed;
document.title = bible.meta.title;

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
document.getElementById("app")!.appendChild(renderer.domElement);

const color = (key: string) => {
  const hex = bible.visual.palette[key];
  if (!hex) throw new Error(`Palette has no "${key}"`);
  return hex;
};
const sceneKeys = bible.visual.scene ?? { background: "void", light: "ember" };
const scene = new THREE.Scene();
scene.background = new THREE.Color(color(sceneKeys.background));
scene.fog = new THREE.Fog(color(sceneKeys.background), 16, 34);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 200);

scene.add(new THREE.HemisphereLight(0xb8b0c8, color(sceneKeys.background), 0.9));
const sun = new THREE.DirectionalLight(0xffe2c0, 1.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30 });
scene.add(sun, sun.target);
const torch = new THREE.PointLight(color(sceneKeys.light), 30, 9, 1.6);
scene.add(torch);

const materials = new Map<string, THREE.MeshStandardMaterial>();
function material(key: string): THREE.MeshStandardMaterial {
  let m = materials.get(key);
  if (!m) {
    const def = bible.visual.materials[key];
    if (!def) throw new Error(`Unknown material ${key}`);
    m = new THREE.MeshStandardMaterial({
      color: color(def.color),
      roughness: def.roughness,
      metalness: def.metalness,
      emissive: def.emissive ? new THREE.Color(color(def.emissive)) : new THREE.Color(0),
      emissiveIntensity: def.emissive ? 0.35 : 0,
      flatShading: true,
    });
    materials.set(key, m);
  }
  return m;
}

const loader = new GLTFLoader();
const gltfCache = new Map<string, Promise<THREE.Object3D>>();
function loadModel(url: string) {
  let p = gltfCache.get(url);
  if (!p) gltfCache.set(url, (p = loader.loadAsync(url).then((g) => g.scene)));
  return p;
}

/** A primitive now, swapped for the cleaned GLB once it loads. */
function entityObject(kind: "player" | "enemy" | "item", matKey: string, model?: string, size = 0.75, round = false): THREE.Object3D {
  const group = new THREE.Group();
  let mesh: THREE.Mesh;
  if (kind === "player") {
    mesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.6, 4, 8), material(matKey));
    mesh.position.y = 0.58;
  } else if (kind === "item") {
    mesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.2), material("loot"));
    mesh.position.y = 0.35;
  } else {
    const geo = round ? new THREE.SphereGeometry(size / 2, 10, 6) : new THREE.ConeGeometry(size / 2.4, size * 1.3, 6);
    mesh = new THREE.Mesh(geo, material(matKey));
    mesh.position.y = round ? size / 2.4 : size * 0.65;
  }
  mesh.castShadow = true;
  const holder = new THREE.Group(); // animated child: lunges move this, hops move the group
  holder.add(mesh);
  group.add(holder);
  const url = project.fileUrl(model);
  if (url) {
    loadModel(url)
      .then((m) => {
        holder.remove(mesh);
        const clone = m.clone(true);
        clone.traverse((o) => (o.castShadow = true));
        holder.add(clone);
      })
      .catch((err) => console.warn(`Model ${model} failed to load, keeping primitive`, err));
  }
  return group;
}

/** Primitive size from the stat block, so tougher enemies read bigger. */
const enemySize = (hp: number) => Math.min(0.95, 0.32 + hp / 40);

let game: Game;
let hud: Hud;
let animator: Animator;
const audio = new GameAudio(project);
const world = new THREE.Group();
scene.add(world);
const objects = new Map<string, THREE.Object3D>();
const lastPos = new Map<string, string>();
let floorShown = 0;

function buildFloor() {
  world.clear();
  objects.clear();
  lastPos.clear();
  const l = game.state.level;
  const floors: [number, number][] = [];
  const walls: [number, number][] = [];
  for (let y = -1; y <= l.height; y++)
    for (let x = -1; x <= l.width; x++) {
      if (tileAt(l, x, y) !== WALL) floors.push([x, y]);
      else {
        let edge = false;
        for (let dy = -1; dy <= 1 && !edge; dy++) for (let dx = -1; dx <= 1; dx++) if (tileAt(l, x + dx, y + dy) !== WALL) edge = true;
        if (edge) walls.push([x, y]);
      }
    }
  const m = new THREE.Matrix4();
  const floorMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.2, 1), material("floor"), floors.length);
  floors.forEach(([x, y], i) => floorMesh.setMatrixAt(i, m.makeTranslation(x, -0.1, y)));
  floorMesh.receiveShadow = true;
  const wallMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.9, 1), material("wall"), walls.length);
  walls.forEach(([x, y], i) => wallMesh.setMatrixAt(i, m.makeTranslation(x, 0.45, y)));
  wallMesh.castShadow = wallMesh.receiveShadow = true;
  const stairs = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.06, 16), material("stairs"));
  stairs.position.set(l.stairs.x, 0.03, l.stairs.y);
  world.add(floorMesh, wallMesh, stairs);
  floorShown = game.state.floor;
}

function sync(dt: number, t: number) {
  const s = game.state;
  if (floorShown !== s.floor) buildFloor();
  const alive = new Set<string>();
  const place = (uid: string, make: () => THREE.Object3D, x: number, y: number, animate: boolean) => {
    alive.add(uid);
    let o = objects.get(uid);
    if (!o) {
      objects.set(uid, (o = make()));
      o.position.set(x, 0, y);
      world.add(o);
      if (animate) animator.track(uid, o);
    }
    const key = `${x},${y}`;
    if (animate && lastPos.has(uid) && lastPos.get(uid) !== key) animator.hop(uid);
    lastPos.set(uid, key);
    const k = animate ? 1 - Math.pow(0.0001, dt) : 1;
    o.position.x += (x - o.position.x) * k;
    o.position.z += (y - o.position.z) * k;
    return o;
  };
  const p = s.player;
  place("player", () => entityObject("player", bible.lore.player.material, bible.lore.player.model), p.pos.x, p.pos.y, true);
  for (const e of s.enemies) {
    const def = bible.lore.bestiary[e.defId]!;
    place(e.uid, () => entityObject("enemy", def.material, def.model, enemySize(def.hp), def.ac < 10), e.pos.x, e.pos.y, true);
  }
  for (const g of s.ground) {
    const o = place(g.item.uid, () => entityObject("item", "loot", game.item(g.item.itemId).model), g.pos.x, g.pos.y, false);
    o.rotation.y = (Math.floor(t * 8) / 8) * 1.5; // stepped spin
    o.position.y = Math.floor(t * 4) % 2 ? 0.05 : 0;
  }
  for (const [uid, o] of objects)
    if (!alive.has(uid)) {
      objects.delete(uid);
      lastPos.delete(uid);
      animator.untrack(uid);
      // Defeated enemies (uids start with f<floor>) play a death pop; picked-up items just vanish.
      if (/^f\d+r\d+e\d+$/.test(uid)) animator.die(o);
      else world.remove(o);
    }
  animator.update(dt);

  const po = objects.get("player")!;
  torch.position.set(po.position.x, 1.6, po.position.z);
  const target = new THREE.Vector3(po.position.x, 0, po.position.z);
  camera.position.lerp(new THREE.Vector3(target.x, 13, target.z + 8), 1 - Math.pow(0.001, dt));
  camera.lookAt(camera.position.x, 0, camera.position.z - 8);
  sun.target.position.copy(target);
  sun.position.set(target.x - 8, 20, target.z + 6);
}

function newRun(nextSeed = seed) {
  seed = nextSeed;
  game = new Game(bible, description, seed);
  hud = new Hud(game, bible);
  animator = new Animator();
  world.clear();
  objects.clear();
  lastPos.clear();
  floorShown = 0;
  audio.bind(game.events);
  game.events.on("attack", (e) => {
    const target = objects.get(e.defender);
    if (target) animator.lunge(e.attacker, target.position);
    if (e.hit) animator.flash(e.defender);
  });
  // Hooks for the headless visual check (scripts/visual.ts).
  Object.assign(window, {
    __qa: {
      game,
      project: project.name,
      botStep: () => game.act(botAction(game)),
      stats: () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }),
    },
  });
}

const KEYS: Record<string, Action> = {
  ArrowUp: { type: "move", dx: 0, dy: -1 },
  KeyW: { type: "move", dx: 0, dy: -1 },
  ArrowDown: { type: "move", dx: 0, dy: 1 },
  KeyS: { type: "move", dx: 0, dy: 1 },
  ArrowLeft: { type: "move", dx: -1, dy: 0 },
  KeyA: { type: "move", dx: -1, dy: 0 },
  ArrowRight: { type: "move", dx: 1, dy: 0 },
  KeyD: { type: "move", dx: 1, dy: 0 },
  Space: { type: "wait" },
  Enter: { type: "descend" },
  NumpadEnter: { type: "descend" },
};
const PAD: Record<string, Action> = {
  up: KEYS.ArrowUp!,
  down: KEYS.ArrowDown!,
  left: KEYS.ArrowLeft!,
  right: KEYS.ArrowRight!,
  wait: KEYS.Space!,
  descend: KEYS.Enter!,
};

addEventListener("keydown", (e) => {
  audio.unlock();
  if (e.repeat && e.code === "Enter") return;
  const action = KEYS[e.code];
  if (action) {
    e.preventDefault();
    game.act(action);
  } else if (/^Digit[1-9]$/.test(e.code)) {
    const inst = game.inventory.items[Number(e.code.slice(5)) - 1];
    if (inst) game.act({ type: "use", uid: inst.uid });
  }
});
addEventListener("pointerdown", () => audio.unlock());
document.querySelectorAll<HTMLButtonElement>("#pad button").forEach((b) =>
  b.addEventListener("click", () => game.act(PAD[b.dataset.k!]!)),
);
document.getElementById("restart")!.addEventListener("click", () => newRun(`${seed.replace(/-r\d+$/, "")}-r${Date.now() % 100000}`));
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

newRun();
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  sync(dt, clock.elapsedTime);
  renderer.render(scene, camera);
});
