// Plays bible-tagged audio assets on game events. Tags on assets decide what
// plays: "sfx:attack", "sfx:hit", "sfx:miss", "sfx:pickup", "sfx:defeat",
// "sfx:descend", "sfx:death", "sfx:victory", "music:explore". Music loops
// between the asset's loop points.
import type { GameEvents } from "../../core/contracts";
import type { EventBus } from "../../core/events";
import type { ProjectData } from "./projectData";

interface Clip {
  url: string;
  loopStart?: number;
  loopEnd?: number;
}

export class GameAudio {
  private ctx?: AudioContext;
  private buffers = new Map<string, Promise<AudioBuffer>>();
  private clips = new Map<string, Clip[]>();
  private music?: AudioBufferSourceNode;

  constructor(project: ProjectData) {
    for (const a of project.registry.assets) {
      const audio = (a as { audio?: { file?: string; loopStart?: number; loopEnd?: number } }).audio;
      const url = project.fileUrl(audio?.file);
      if (!url) continue;
      for (const tag of (a as { tags?: string[] }).tags ?? []) {
        const list = this.clips.get(tag) ?? [];
        list.push({ url, loopStart: audio?.loopStart, loopEnd: audio?.loopEnd });
        this.clips.set(tag, list);
      }
    }
  }

  get hasAudio() {
    return this.clips.size > 0;
  }

  /** Browsers only allow sound after a user gesture. */
  unlock() {
    if (this.ctx || !this.hasAudio) return;
    this.ctx = new AudioContext();
    this.playMusic("music:explore");
  }

  bind(events: EventBus<GameEvents>) {
    events.on("attack", (e) => this.play(e.hit ? (e.defender === "player" ? "sfx:hurt" : "sfx:hit") : "sfx:miss", "sfx:attack"));
    events.on("itemPickedUp", () => this.play("sfx:pickup"));
    events.on("enemyDefeated", () => this.play("sfx:defeat"));
    events.on("floorChanged", ({ floor }) => floor > 1 && this.play("sfx:descend"));
    events.on("gameOver", ({ won }) => {
      this.music?.stop();
      this.play(won ? "sfx:victory" : "sfx:death");
    });
  }

  private load(url: string) {
    let b = this.buffers.get(url);
    if (!b) {
      b = fetch(url)
        .then((r) => r.arrayBuffer())
        .then((data) => this.ctx!.decodeAudioData(data));
      this.buffers.set(url, b);
    }
    return b;
  }

  /** Plays a random clip for the first tag that has any. */
  play(...tags: string[]) {
    if (!this.ctx) return;
    const list = tags.map((t) => this.clips.get(t)).find((l) => l?.length);
    if (!list) return;
    const clip = list[Math.floor(Math.random() * list.length)]!;
    void this.load(clip.url).then((buf) => {
      const src = this.ctx!.createBufferSource();
      src.buffer = buf;
      src.connect(this.ctx!.destination);
      src.start();
    });
  }

  private playMusic(tag: string) {
    const clip = this.clips.get(tag)?.[0];
    if (!clip || !this.ctx) return;
    void this.load(clip.url).then((buf) => {
      this.music?.stop();
      const src = this.ctx!.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.loopStart = clip.loopStart ?? 0;
      src.loopEnd = clip.loopEnd ?? buf.duration;
      const gain = this.ctx!.createGain();
      gain.gain.value = 0.5;
      src.connect(gain).connect(this.ctx!.destination);
      src.start();
      this.music = src;
    });
  }
}
