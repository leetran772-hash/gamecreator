import type { Bible } from "./types";

/** Checks cross-references inside a bible. Returns a list of problems (empty = valid). */
export function validateBible(b: Bible): string[] {
  const problems: string[] = [];
  const { visual, lore } = b;
  const hex = /^#[0-9a-f]{6}$/i;

  for (const [k, v] of Object.entries(visual.palette)) {
    if (!hex.test(v)) problems.push(`visual.palette.${k}: "${v}" is not a #rrggbb color`);
  }
  for (const [k, m] of Object.entries(visual.materials)) {
    if (!(m.color in visual.palette)) problems.push(`visual.materials.${k}: color "${m.color}" is not in the palette`);
    if (m.emissive && !(m.emissive in visual.palette))
      problems.push(`visual.materials.${k}: emissive "${m.emissive}" is not in the palette`);
  }
  for (const key of ["floor", "wall", "loot", "stairs"])
    if (!(key in visual.materials)) problems.push(`visual.materials: engines need a "${key}" material`);
  if (visual.scene) {
    for (const [k, v] of Object.entries(visual.scene))
      if (!(v in visual.palette)) problems.push(`visual.scene.${k}: "${v}" is not in the palette`);
  }
  if (!(lore.player.material in visual.materials)) problems.push(`lore.player: unknown material "${lore.player.material}"`);

  for (const [id, item] of Object.entries(lore.items)) {
    if (item.id !== id) problems.push(`lore.items.${id}: id field is "${item.id}"`);
    if (item.kind === "weapon" && !item.stats.damage) problems.push(`lore.items.${id}: weapon without damage`);
    if (item.kind === "armor" && item.stats.armorClass === undefined) problems.push(`lore.items.${id}: armor without armorClass`);
    if (item.kind === "potion" && !item.stats.heal) problems.push(`lore.items.${id}: potion without heal`);
  }
  for (const [id, t] of Object.entries(lore.lootTables)) {
    if (t.rolls < 1) problems.push(`lore.lootTables.${id}: rolls must be >= 1`);
    for (const e of t.entries) {
      if (!(e.item in lore.items)) problems.push(`lore.lootTables.${id}: unknown item "${e.item}"`);
      if (e.weight <= 0) problems.push(`lore.lootTables.${id}: "${e.item}" has non-positive weight`);
    }
  }
  for (const [id, e] of Object.entries(lore.bestiary)) {
    if (e.id !== id) problems.push(`lore.bestiary.${id}: id field is "${e.id}"`);
    if (!(e.lootTable in lore.lootTables)) problems.push(`lore.bestiary.${id}: unknown loot table "${e.lootTable}"`);
    if (!(e.material in visual.materials)) problems.push(`lore.bestiary.${id}: unknown material "${e.material}"`);
  }
  if (!Object.values(lore.bestiary).some((e) => e.minFloor <= 1)) problems.push("lore.bestiary: no enemy can spawn on floor 1");
  return problems;
}
