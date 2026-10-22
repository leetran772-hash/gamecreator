// Small GLB viewer for the asset browser.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export function modelViewer(el: HTMLElement, url: string, palette: Record<string, string>): () => void {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  const size = () => [el.clientWidth || 400, el.clientHeight || 400] as const;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(...size());
  el.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
  camera.position.set(2, 1.6, 2.4);
  scene.add(new THREE.HemisphereLight(0xffffff, Object.values(palette)[0] ?? 0x222222, 1.4));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(3, 5, 2);
  scene.add(key);
  const grid = new THREE.GridHelper(4, 8, 0x888888, 0x444444);
  scene.add(grid);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.8, 0);
  new GLTFLoader().load(url, (g) => {
    scene.add(g.scene);
    const box = new THREE.Box3().setFromObject(g.scene);
    const h = Math.max(0.2, box.max.y - box.min.y);
    controls.target.set(0, h / 2, 0);
    camera.position.set(h * 1.4, h * 1.1, h * 1.7);
  });
  let alive = true;
  const loop = () => {
    if (!alive) return;
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  };
  loop();
  return () => {
    alive = false;
    renderer.dispose();
  };
}
