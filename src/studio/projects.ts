// Project folders: each one is the source of truth for a game (bible, game
// description, assets, approvals, costs). New projects start from a starter bible.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Bible } from "../bible/types";
import type { GameDescription } from "../core/description";
import { loadBibleFrom } from "../pipeline/assetPipeline";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const PROJECTS_DIR = join(REPO_ROOT, "projects");
export const STARTERS_DIR = join(REPO_ROOT, "studio", "starters");

export const STARTERS = ["dark-fantasy", "low-poly-cozy", "retro-sci-fi"] as const;
export type Starter = (typeof STARTERS)[number];

const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function projectDir(name: string, root = PROJECTS_DIR): string {
  if (!NAME.test(name)) throw new Error(`Bad project name "${name}" (use lowercase letters, digits and dashes)`);
  return join(root, name);
}

export function listProjects(root = PROJECTS_DIR): { name: string; title: string; approved: boolean; version: number }[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, "bible", "meta.json")))
    .map((d) => {
      const meta = JSON.parse(readFileSync(join(root, d.name, "bible", "meta.json"), "utf8")) as Bible["meta"];
      return { name: d.name, title: meta.title, approved: meta.approved, version: meta.version };
    });
}

export function loadProject(dir: string): { bible: Bible; description: GameDescription } {
  return {
    bible: loadBibleFrom(dir),
    description: JSON.parse(readFileSync(join(dir, "game.json"), "utf8")) as GameDescription,
  };
}

export interface NewProject {
  name: string;
  starter: Starter;
  pitch?: string;
  title?: string;
}

/** Copies a starter bible into projects/<name>. The bible starts unapproved: the user approves it before any Meshy or ElevenLabs spend. */
export function createProject(p: NewProject, root = PROJECTS_DIR): string {
  const dir = projectDir(p.name, root);
  if (existsSync(dir)) throw new Error(`Project "${p.name}" already exists`);
  if (!STARTERS.includes(p.starter)) throw new Error(`Unknown starter "${p.starter}". Options: ${STARTERS.join(", ")}`);
  mkdirSync(dirname(dir), { recursive: true });
  cpSync(join(STARTERS_DIR, p.starter), dir, { recursive: true });
  const metaPath = join(dir, "bible", "meta.json");
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Bible["meta"];
  if (p.pitch) meta.pitch = p.pitch;
  if (p.title) meta.title = p.title;
  meta.version = 1;
  meta.approved = false;
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
  const gamePath = join(dir, "game.json");
  const game = JSON.parse(readFileSync(gamePath, "utf8")) as GameDescription;
  game.defaultSeed = `${p.name}-1`;
  writeFileSync(gamePath, JSON.stringify(game, null, 2) + "\n");
  return dir;
}
