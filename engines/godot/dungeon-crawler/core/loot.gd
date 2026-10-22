# Loot roller. Hard dependency on the seeder; listens for combat's
# enemyDefeated event (wired in game.gd). Each drop uses a stream keyed by the
# enemy's uid, so adding or removing other enemies never changes what this one
# drops. Port of src/core/loot.ts.
extends RefCounted


## table: bible lore.lootTables entry {rolls, nothingWeight, entries:[{item, weight}]}.
## Returns item instances [{uid, itemId}].
static func roll_loot(rng: RefCounted, table: Dictionary, uid_prefix: String) -> Array:
	var drops: Array = []
	var entries: Array = table.entries.duplicate()
	entries.append({"item": "", "weight": table.nothingWeight})
	for i in int(table.rolls):
		var pick: Dictionary = rng.weighted(entries)
		if pick.item != "":
			drops.append({"uid": "%s-%d" % [uid_prefix, i], "itemId": pick.item})
	return drops


## Expected chance of each item per roll, for balance checks.
static func expected_drop_rates(table: Dictionary) -> Dictionary:
	var total := float(table.nothingWeight)
	for e in table.entries:
		total += float(e.weight)
	var out := {}
	for e in table.entries:
		out[e.item] = out.get(e.item, 0.0) + float(e.weight) / total
	return out
