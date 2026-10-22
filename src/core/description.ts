// Engine-neutral game description: entities, behaviors, controls and levels
// stored as data. Engine code (Godot or Three.js) is generated from / driven by
// this, so there are never two hand-synced codebases.
import type { LevelOptions } from "./level";

export interface GameDescription {
  template: "dungeon-crawler";
  engines: ("threejs" | "godot")[];
  /** Encyclopedia entry ids this game is built from. */
  modules: string[];
  defaultSeed: string;
  floors: number;
  level: LevelOptions;
  spawns: {
    enemiesPerRoom: [number, number];
    itemChancePerRoom: number;
    floorItemTable: string;
  };
  player: {
    inventoryCapacity: number;
    startingItems: string[];
    xpPerLevel: number;
    hpPerLevel: number;
  };
  entities: Record<string, { behaviors: string[] }>;
  controls: Record<string, string[]>;
  qa: {
    playtestRuns: number;
    maxTurnsPerFloor: number;
    botWinRate: [number, number];
    duelRuns: number;
    /** Base player must beat each floor-1 enemy at least this often. */
    minFloorOneDuelWinRate: number;
    lootRolls: number;
    lootTolerance: number;
  };
}
