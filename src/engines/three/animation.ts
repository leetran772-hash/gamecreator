// GBA-style basic animation: few-frame, snappy procedural motion. Time is
// quantized to 12 fps so it reads like hand-made sprite frames.
import * as THREE from "three";

const FPS = 12;
const stepped = (t: number) => Math.floor(t * FPS) / FPS;

interface Track {
  obj: THREE.Object3D;
  hopStart: number;
  lungeStart: number;
  lungeDir: THREE.Vector3;
  flashStart: number;
  idlePhase: number;
}

export class Animator {
  private tracks = new Map<string, Track>();
  private dying: { obj: THREE.Object3D; start: number }[] = [];
  private flashMaterials = new WeakMap<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private white = new THREE.MeshBasicMaterial({ color: 0xffffff });
  time = 0;

  track(uid: string, obj: THREE.Object3D) {
    if (!this.tracks.has(uid))
      this.tracks.set(uid, { obj, hopStart: -1, lungeStart: -1, lungeDir: new THREE.Vector3(), flashStart: -1, idlePhase: (uid.length * 1.7) % 6 });
  }

  untrack(uid: string) {
    this.tracks.delete(uid);
  }

  hop(uid: string) {
    const t = this.tracks.get(uid);
    if (t) t.hopStart = this.time;
  }

  lunge(uid: string, toward: THREE.Vector3) {
    const t = this.tracks.get(uid);
    if (!t) return;
    t.lungeStart = this.time;
    t.lungeDir.copy(toward).sub(t.obj.position).setY(0).normalize();
  }

  flash(uid: string) {
    const t = this.tracks.get(uid);
    if (t) t.flashStart = this.time;
  }

  /** Detaches the object and plays a pop-and-shrink, then removes it. */
  die(obj: THREE.Object3D) {
    this.dying.push({ obj, start: this.time });
  }

  update(dt: number) {
    this.time += dt;
    const now = this.time;
    for (const t of this.tracks.values()) {
      const child = t.obj.children[0];
      if (!child) continue;
      // Idle: two-frame breathing bob.
      const idle = Math.floor(stepped(now + t.idlePhase) * 2) % 2 === 0 ? 0 : 0.03;
      // Hop: 4-frame arc with squash on landing.
      const h = (now - t.hopStart) * FPS;
      let y = idle;
      let sy = 1;
      if (t.hopStart >= 0 && h < 4) {
        const f = Math.floor(h);
        y += [0.12, 0.18, 0.1, 0][f]!;
        sy = [1.08, 1.1, 1, 0.82][f]!;
      }
      // Lunge: 3 frames forward and back.
      const l = (now - t.lungeStart) * FPS;
      const off = t.lungeStart >= 0 && l < 3 ? [0.25, 0.35, 0.1][Math.floor(l)]! : 0;
      child.position.x = t.lungeDir.x * off;
      child.position.z = t.lungeDir.z * off;
      t.obj.position.y = y;
      t.obj.scale.set(1 / Math.sqrt(sy), sy, 1 / Math.sqrt(sy));
      // Hit flash: 2 white frames.
      const fl = (now - t.flashStart) * FPS;
      this.setFlash(t.obj, t.flashStart >= 0 && fl < 2 && Math.floor(fl) % 2 === 0);
    }
    this.dying = this.dying.filter((d) => {
      const f = Math.floor((now - d.start) * FPS);
      if (f >= 5) {
        d.obj.removeFromParent();
        return false;
      }
      const s = [1.25, 1, 0.7, 0.4, 0.15][f]!;
      d.obj.scale.setScalar(s);
      d.obj.rotation.y = f * 0.6;
      this.setFlash(d.obj, f % 2 === 0);
      return true;
    });
  }

  private setFlash(obj: THREE.Object3D, on: boolean) {
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (on && !this.flashMaterials.has(m)) {
        this.flashMaterials.set(m, m.material);
        m.material = this.white;
      } else if (!on && this.flashMaterials.has(m)) {
        m.material = this.flashMaterials.get(m)!;
        this.flashMaterials.delete(m);
      }
    });
  }
}
