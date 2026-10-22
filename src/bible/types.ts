// Element bible: what a game *is*. Stored as JSON files, one per layer, so
// each pipeline step loads only the slice it needs.
import type { Item } from "../core/contracts";

export interface ConceptRef {
  id: string;
  /** Image path relative to the project folder. */
  image: string;
  kind: "mood" | "asset" | "user-reference";
  subject?: string;
  approved: boolean;
  bibleVersion: number;
}

export interface VisualLayer {
  palette: Record<string, string>;
  materials: Record<string, { color: string; roughness: number; metalness: number; emissive?: string }>;
  /** Palette keys for the scene background and the player's light. */
  scene?: { background: string; light: string };
  polyBudgets: { character: number; prop: number; environment: number };
  textureResolution: number;
  styleNotes: string;
  concepts: ConceptRef[];
}

export interface AudioLayer {
  voices: Record<string, { voiceId: string; notes: string }>;
  sfxStyle: string;
  musicMoods: Record<string, string>;
}

export interface StatBlock {
  name: string;
  hp: number;
  ac: number;
  attackBonus: number;
  damage: string;
}

export interface EnemyDef extends StatBlock {
  id: string;
  description: string;
  material: string;
  lootTable: string;
  xp: number;
  minFloor: number;
  spawnWeight: number;
  sightRange: number;
  model?: string;
}

export interface LootTable {
  rolls: number;
  nothingWeight: number;
  entries: { item: string; weight: number }[];
}

export interface LoreLayer {
  tone: string;
  rules: string[];
  factions: { id: string; name: string; description: string }[];
  characters: { id: string; name: string; role: string; description: string }[];
  player: StatBlock & { material: string; model?: string };
  bestiary: Record<string, EnemyDef>;
  items: Record<string, Item>;
  lootTables: Record<string, LootTable>;
}

export interface EngineConventions {
  entityStructure: string;
  controls: Record<string, string[]>;
  saves: string;
}

export interface CodeLayer {
  godot: EngineConventions;
  threejs: EngineConventions;
}

export interface BibleMeta {
  title: string;
  pitch: string;
  genre: string;
  style: string;
  /** Bumped on every approved change; every asset records the version it was built against. */
  version: number;
  approved: boolean;
}

export interface Bible {
  meta: BibleMeta;
  visual: VisualLayer;
  audio: AudioLayer;
  lore: LoreLayer;
  code: CodeLayer;
}
