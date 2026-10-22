// Shared contracts. Every module (and every engine implementation) speaks
// only these shapes, which keeps Godot and Three.js implementations aligned.

export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary";
export type ItemKind = "weapon" | "armor" | "potion" | "treasure";

export interface ItemStats {
  /** Weapons: added to the attack roll. */
  attackBonus?: number;
  /** Weapons: damage dice, e.g. "1d8+1". */
  damage?: string;
  /** Armor: armor class while worn. */
  armorClass?: number;
  /** Potions: healing dice. */
  heal?: string;
  /** Treasure: score value. */
  value?: number;
}

/** Item schema: ID, rarity, stats, icon, 3D model reference. */
export interface Item {
  id: string;
  name: string;
  kind: ItemKind;
  rarity: Rarity;
  stats: ItemStats;
  /** Icon path relative to the project folder, or an emoji placeholder. */
  icon: string;
  /** GLB path relative to the project folder; engines fall back to a primitive. */
  model?: string;
}

/** One concrete copy of an item in the world or an inventory. */
export interface ItemInstance {
  uid: string;
  itemId: string;
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface InventorySnapshot {
  items: ItemInstance[];
  equipped: { weapon?: ItemInstance; armor?: ItemInstance };
  capacity: number;
}

export interface GameEvents {
  enemyDefeated: { enemyUid: string; enemyId: string; floor: number; position: Vec2; xp: number };
  itemPickedUp: { item: ItemInstance; position: Vec2 };
  inventoryChanged: InventorySnapshot;
  // Extra events used by the HUD and log.
  attack: {
    attacker: string;
    defender: string;
    roll: number;
    total: number;
    targetAc: number;
    hit: boolean;
    crit: boolean;
    damage: number;
  };
  lootDropped: { item: ItemInstance; position: Vec2; sourceUid: string };
  playerHealthChanged: { hp: number; maxHp: number };
  floorChanged: { floor: number };
  gameOver: { won: boolean; floor: number; turn: number };
  message: { text: string };
}
