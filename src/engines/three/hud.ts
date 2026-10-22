// UI/HUD kit: driven only by inventory and combat events from the core.
import type { Bible } from "../../bible/types";
import type { Game } from "../../core/game";

const $ = (id: string) => document.getElementById(id)!;

export class Hud {
  private lines: string[] = [];

  constructor(
    private game: Game,
    private bible: Bible,
  ) {
    $("title").textContent = bible.meta.title;
    $("overlay").hidden = true;
    const ev = game.events;
    ev.on("message", ({ text }) => this.log(text));
    ev.on("playerHealthChanged", () => this.stats());
    ev.on("inventoryChanged", () => this.inventory());
    ev.on("floorChanged", () => this.stats());
    ev.on("enemyDefeated", () => this.stats());
    ev.on("itemPickedUp", () => this.stats());
    ev.on("gameOver", ({ won, floor, turn }) => {
      const s = game.state;
      $("overlay-title").textContent = won ? "You escaped" : "You died";
      $("overlay-text").textContent = `Floor ${floor} · turn ${turn} · ${s.kills} kills · ${s.player.gold} gold · seed "${s.seed}"`;
      $("overlay").hidden = false;
    });
    this.lines = [];
    $("log").innerHTML = "";
    this.log(`You enter ${bible.meta.title}. Find the glowing stairs.`);
    this.stats();
    this.inventory();
  }

  private stats() {
    const s = this.game.state;
    const p = s.player;
    $("stats").textContent = `Floor ${s.floor}/${this.game.desc.floors} · Lv ${p.level} · AC ${p.ac} · ATK +${p.attackBonus} (${p.damage}) · ${p.gold} gold · seed ${s.seed}`;
    ($("hpfill") as HTMLElement).style.width = `${Math.max(0, (p.hp / p.maxHp) * 100)}%`;
    $("hptext").textContent = `HP ${Math.max(0, p.hp)} / ${p.maxHp}`;
  }

  private inventory() {
    const inv = this.game.inventory;
    const name = (itemId: string) => {
      const it = this.game.item(itemId);
      return `${it.icon} ${it.name}`;
    };
    const eq = [inv.equipped.weapon, inv.equipped.armor].filter(Boolean).map((i) => `<div class="slot equipped">${name(i!.itemId)}</div>`);
    const bag = inv.items.map((i, n) => `<div class="slot"><span class="key">${n + 1}</span>${name(i.itemId)}</div>`);
    $("inventory").innerHTML = `<h3>Equipped</h3>${eq.join("") || "<div>—</div>"}<h3 style="margin-top:8px">Pack ${inv.items.length}/${inv.capacity}</h3>${bag.join("") || "<div>empty</div>"}`;
  }

  private log(text: string) {
    this.lines.unshift(text);
    this.lines.length = Math.min(this.lines.length, 8);
    $("log").innerHTML = this.lines.map((l) => `<div>${escapeHtml(l)}</div>`).join("");
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
