# Parity dump: the same numbers src/qa/parity.ts computes in TypeScript.
# tests/godot.test.ts runs both and asserts exact equality, so the Godot port
# can never silently drift from the engine-neutral core.
#   godot --headless --path <project> --script res://qa/parity.gd -- \
#     --seeds a,b,c [--rng 32] [--floors 3] [--turns 300] [--full-runs 20] [--data <dir>]
# Prints one line "PARITY_JSON {...}".
extends SceneTree

const Bible := preload("res://core/bible.gd")
const Seeder := preload("res://core/seeder.gd")
const Level := preload("res://core/level.gd")
const Loot := preload("res://core/loot.gd")
const Game := preload("res://core/game.gd")
const Bot := preload("res://qa/bot.gd")
const Playtest := preload("res://qa/playtest.gd")

const STREAMS := ["", "level:1", "combat:1", "loot:f1r2e0", "spawn:2:3", "spawn:2:3/item", "heal:it-1"]
const DICE := ["1d4+1", "2d6", "1d10+2", "4d4+8", "d8", "3d6-2", "7"]
const EVENTS := ["enemyDefeated", "itemPickedUp", "inventoryChanged", "attack", "lootDropped", "playerHealthChanged", "floorChanged", "gameOver", "message"]
const HASHES := ["", "a", "ashen-1", "playtest-0/loot:f1r1e0", "ünïcödé 🔥 seed", "日本語"]


static func v2(p: Vector2i) -> Dictionary:
	return {"x": p.x, "y": p.y}


static func dump_rng(seed: String, bible: Dictionary, n: int) -> Dictionary:
	var root := Seeder.new(seed)
	var streams := {}
	for name in STREAMS:
		var r: RefCounted = root
		if name != "":
			for part in name.split("/"):
				r = r.fork(part)
		var out: Array = []
		for i in n:
			out.append(r.next_uint())
		streams[name] = out
	var r := root.fork("parity")
	var ints: Array = []
	for i in n:
		ints.append(r.int_range(1, 6))
		ints.append(r.int_range(-5, 5))
		ints.append(r.int_range(0, 1000000))
	var chances: Array = []
	for i in n:
		chances.append(r.chance(0.45))
	var weighted: Array = []
	for table_id in bible.lore.lootTables:
		var table: Dictionary = bible.lore.lootTables[table_id]
		var entries: Array = table.entries.duplicate()
		entries.append({"item": "", "weight": table.nothingWeight})
		for i in n:
			weighted.append(r.weighted(entries).item)
	var picks: Array = []
	for i in n:
		picks.append(r.pick(["a", "b", "c", "d", "e"]))
	var dice: Array = []
	for expr in DICE:
		for i in 4:
			var roll := Seeder.roll_dice(r, expr)
			dice.append({"expr": expr, "total": roll.total, "rolls": roll.rolls})
		dice.append({"expr": expr, "crit": Seeder.roll_dice(r, expr, Seeder.parse_dice(expr).count).total})
	var loot: Array = []
	for table_id in bible.lore.lootTables:
		for i in 8:
			loot.append(Loot.roll_loot(root.fork("loot:%s:%d" % [table_id, i]), bible.lore.lootTables[table_id], "%s-%d" % [table_id, i]))
	return {"streams": streams, "ints": ints, "chances": chances, "weighted": weighted, "picks": picks, "dice": dice, "loot": loot}


static func dump_level(l: RefCounted) -> Dictionary:
	var rows: Array = []
	for y in l.height:
		var row := ""
		for x in l.width:
			row += "#" if l.tile_at(x, y) == Level.WALL else "."
		rows.append(row)
	var rooms: Array = []
	for r in l.rooms:
		rooms.append({"x": r.x, "y": r.y, "w": r.w, "h": r.h})
	return {"width": l.width, "height": l.height, "tiles": rows, "rooms": rooms, "start": v2(l.start), "stairs": v2(l.stairs)}


static func dump_entities(game: RefCounted) -> Dictionary:
	var enemies: Array = []
	for e in game.enemies:
		enemies.append({"uid": e.uid, "defId": e.def_id, "pos": v2(e.pos), "hp": e.hp, "maxHp": e.max_hp, "ac": e.ac, "attackBonus": e.attack_bonus, "damage": e.damage, "sightRange": e.sight_range, "awake": e.awake})
	var ground: Array = []
	for g in game.ground:
		ground.append({"uid": g.item.uid, "itemId": g.item.itemId, "pos": v2(g.pos)})
	return {"enemies": enemies, "ground": ground}


static func dump_state(game: RefCounted) -> Dictionary:
	var p = game.player
	var inv: RefCounted = game.inventory
	var equipped := {}
	for slot in ["weapon", "armor"]:
		if inv.equipped.has(slot):
			equipped[slot] = inv.equipped[slot].uid
	var ents := dump_entities(game)
	return {
		"seed": game.seed, "floor": game.floor_num, "turn": game.turn, "turnsOnFloor": game.turns_on_floor,
		"status": game.status, "kills": game.kills,
		"player": {"pos": v2(p.pos), "hp": p.hp, "maxHp": p.max_hp, "ac": p.ac, "attackBonus": p.attack_bonus, "damage": p.damage, "xp": p.xp, "level": p.level, "gold": p.gold},
		"enemies": ents.enemies, "ground": ents.ground,
		"inventory": {"items": inv.items.map(func(i): return i.uid + ":" + i.itemId), "equipped": equipped},
	}


static func dump(bible: Dictionary, desc: Dictionary, seeds: Array, opts: Dictionary) -> Dictionary:
	var hashes := {}
	for s in HASHES:
		hashes[s] = Seeder.hash_string(s)
	var out := {"hashes": hashes, "seeds": {}}
	for seed in seeds:
		var entry := {"rng": dump_rng(seed, bible, int(opts.rng))}
		# (b) levels straight from the generator, (c) spawns via the game.
		var levels: Array = []
		var spawns: Array = []
		var root := Seeder.new(seed)
		var game: RefCounted = Game.new(bible, desc, seed)
		for f in range(1, int(opts.floors) + 1):
			levels.append(dump_level(Level.generate(root.fork("level:%d" % f), desc.level)))
			if f > 1:
				game.enter_floor(f)
			spawns.append(dump_entities(game))
		entry.levels = levels
		entry.spawns = spawns
		# (d) the bot plays K turns; log every event.
		var g: RefCounted = Game.new(bible, desc, seed)
		var log := {"messages": [], "counts": {}}
		for ev in EVENTS:
			log.counts[ev] = 0
			g.events.on(ev, func(payload: Dictionary) -> void:
				log.counts[ev] += 1
				if ev == "message":
					log.messages.append(payload.text))
		var actions := 0
		while g.status == "playing" and actions < int(opts.turns):
			g.act(Bot.bot_action(g))
			actions += 1
		entry.play = {"actions": actions, "state": dump_state(g), "messages": log.messages, "eventCounts": log.counts}
		out.seeds[seed] = entry
	var full: Array = []
	for i in int(opts.fullRuns):
		full.append(Bot.play_run(bible, desc, "playtest-%d" % i, []))
	out.fullRuns = full
	return out


func _initialize() -> void:
	var args: Dictionary = Playtest.parse_args()
	var project := Bible.load_project(args.get("data", "res://data"))
	var seeds: Array = Array(String(args.get("seeds", "ashen-1")).split(",", false))
	var opts := {"rng": int(args.get("rng", "32")), "floors": int(args.get("floors", "3")), "turns": int(args.get("turns", "300")), "fullRuns": int(args.get("full-runs", "0"))}
	print("PARITY_JSON " + JSON.stringify(dump(project.bible, project.desc, seeds, opts)))
	quit(0)
