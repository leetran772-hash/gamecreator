# Automated playtesting, GDScript port of src/qa/playtest.ts: a bot plays
# seeded runs and flags crashes, softlocks and unreachable areas.
# Same policy as the TypeScript bot, so the same seed plays out identically.
extends RefCounted

const Game := preload("res://core/game.gd")
const Level := preload("res://core/level.gd")

static var _score_re: RegEx


## Every floor tile, enemy, item and the stairs must be reachable from the start.
static func check_reachability(game: RefCounted) -> Array[String]:
	var l: RefCounted = game.level
	var dist: PackedInt32Array = l.distance_map(l.start)
	var reach := func(p: Vector2i) -> bool: return dist[p.y * l.width + p.x] >= 0
	var problems: Array[String] = []
	if not reach.call(l.stairs):
		problems.append("stairs at %d,%d unreachable" % [l.stairs.x, l.stairs.y])
	for e in game.enemies:
		if not reach.call(e.pos):
			problems.append("enemy %s unreachable" % e.uid)
	for g in game.ground:
		if not reach.call(g.pos):
			problems.append("item %s unreachable" % g.item.uid)
	var islands := 0
	for i in l.tiles.size():
		if l.tiles[i] == Level.FLOOR and dist[i] < 0:
			islands += 1
	if islands > 0:
		problems.append("%d floor tiles unreachable" % islands)
	return problems


## Simple but competent policy: heal when low, gear up, clear, descend.
static func bot_action(game: RefCounted) -> Dictionary:
	var p = game.player
	var inv: RefCounted = game.inventory
	var potions: Array = inv.items.filter(func(i): return game.item(i.itemId).kind == "potion")
	if p.hp <= p.max_hp * 0.4 and not potions.is_empty():
		return {"type": "use", "uid": potions[0].uid}

	# Equip anything strictly better.
	for inst in inv.items:
		var it: Dictionary = game.item(inst.itemId)
		if it.kind == "weapon":
			var cur = game.item(inv.equipped.weapon.itemId) if inv.equipped.has("weapon") else null
			if cur == null or score(it.stats) > score(cur.stats):
				return {"type": "use", "uid": inst.uid}
		if it.kind == "armor":
			var cur = game.item(inv.equipped.armor.itemId) if inv.equipped.has("armor") else null
			var cur_ac: int = int(cur.stats.get("armorClass", 0)) if cur else 0
			if int(it.stats.get("armorClass", 0)) > cur_ac:
				return {"type": "use", "uid": inst.uid}

	for d in Level.DIRS:
		if game.enemy_at(p.pos.x + d.x, p.pos.y + d.y):
			return {"type": "move", "dx": d.x, "dy": d.y}

	var on_stairs: bool = p.pos == game.level.stairs
	var goals: Array[Vector2i] = []
	for e in game.enemies:
		goals.append(e.pos)
	if not inv.is_full():
		for g in game.ground:
			goals.append(g.pos)
	if goals.is_empty():
		return {"type": "descend"} if on_stairs else step_toward(game, game.level.stairs)
	var step = step_toward_nearest(game, goals)
	if step != null:
		return step
	return {"type": "descend"} if on_stairs else step_toward(game, game.level.stairs)


static func score(stats: Dictionary) -> float:
	if _score_re == null:
		_score_re = RegEx.create_from_string("^(\\d*)d(\\d+)(?:\\+(\\d+))?")
	var m := _score_re.search(String(stats.get("damage", "1d1")))
	var avg := 0.0
	if m:
		var count := float(m.get_string(1)) if m.get_string(1) != "" else 1.0
		var mod := float(m.get_string(3)) if m.get_string(3) != "" else 0.0
		avg = (count * (float(m.get_string(2)) + 1.0)) / 2.0 + mod
	return avg + float(stats.get("attackBonus", 0)) * 0.5


## Mask of tiles holding an enemy, except `allowed` tile indices.
static func _enemy_mask(game: RefCounted, allowed: Dictionary) -> PackedByteArray:
	var l: RefCounted = game.level
	var mask := PackedByteArray()
	mask.resize(l.width * l.height)
	for e in game.enemies:
		var i: int = e.pos.y * l.width + e.pos.x
		if not allowed.has(i):
			mask[i] = 1
	return mask


static func step_toward_nearest(game: RefCounted, goals: Array[Vector2i]) -> Variant:
	var l: RefCounted = game.level
	# Distance from the player; enemies block except goal tiles.
	var goal_set := {}
	var stop := PackedByteArray()
	stop.resize(l.width * l.height)
	for g in goals:
		goal_set[g.y * l.width + g.x] = true
		stop[g.y * l.width + g.x] = 1
	# Early exit at the nearest goal: every goal at that distance is still found.
	var dist: PackedInt32Array = l.distance_map(game.player.pos, _enemy_mask(game, goal_set), stop, 0)
	var target = null
	var best := 1 << 40
	for g in goals:
		var d := dist[g.y * l.width + g.x]
		if d > 0 and d < best:
			best = d
			target = g
	return step_toward(game, target) if target != null else null


static func step_toward(game: RefCounted, target: Vector2i) -> Dictionary:
	var l: RefCounted = game.level
	# Only the player's neighbours matter. They are within 2 steps of each
	# other (through the player's tile), so stop 2 past the first one reached.
	var stop := PackedByteArray()
	stop.resize(l.width * l.height)
	for d in Level.DIRS:
		var nx: int = game.player.pos.x + d.x
		var ny: int = game.player.pos.y + d.y
		if nx >= 0 and ny >= 0 and nx < l.width and ny < l.height:
			stop[ny * l.width + nx] = 1
	var dist: PackedInt32Array = l.distance_map(target, _enemy_mask(game, {target.y * l.width + target.x: true}), stop, 2)
	var best_dir: Vector2i = Level.DIRS[0]
	var best := 1 << 40
	for d in Level.DIRS:
		var nx: int = game.player.pos.x + d.x
		var ny: int = game.player.pos.y + d.y
		if nx < 0 or ny < 0 or nx >= l.width or ny >= l.height:
			continue
		var v := dist[ny * l.width + nx]
		if v >= 0 and v < best:
			best = v
			best_dir = d
	return {"type": "wait"} if best == 1 << 40 else {"type": "move", "dx": best_dir.x, "dy": best_dir.y}


## Plays one seeded run. `errors` is a counter object whose `.count` grows when
## the engine logs a script error (GDScript has no exceptions; see playtest.gd).
static func play_run(bible: Dictionary, desc: Dictionary, seed: String, issues: Array, errors: Object = null) -> Dictionary:
	var before: int = errors.count if errors else 0
	var game: RefCounted = Game.new(bible, desc, seed)
	var floor_checked := 0
	var idle := 0
	var max_turns := int(desc.qa.maxTurnsPerFloor)
	while game.status == "playing":
		if errors and errors.count > before:
			issues.append({"seed": seed, "floor": game.floor_num, "kind": "crash", "detail": errors.last})
			return _result(game, seed, "crash")
		if floor_checked != game.floor_num:
			floor_checked = game.floor_num
			for detail in check_reachability(game):
				issues.append({"seed": seed, "floor": game.floor_num, "kind": "unreachable", "detail": detail})
		if game.turns_on_floor > max_turns:
			issues.append({"seed": seed, "floor": game.floor_num, "kind": "softlock", "detail": "no progress after %d turns" % game.turns_on_floor})
			return _result(game, seed, "softlock")
		var acted = game.act(bot_action(game))
		if typeof(acted) != TYPE_BOOL:
			issues.append({"seed": seed, "floor": game.floor_num, "kind": "crash", "detail": errors.last if errors else "act() failed"})
			return _result(game, seed, "crash")
		idle = 0 if acted else idle + 1
		if idle > 20:
			issues.append({"seed": seed, "floor": game.floor_num, "kind": "softlock", "detail": "bot has no valid action"})
			return _result(game, seed, "softlock")
	if errors and errors.count > before:
		issues.append({"seed": seed, "floor": game.floor_num, "kind": "crash", "detail": errors.last})
		return _result(game, seed, "crash")
	return _result(game, seed, game.status)


static func _result(game: RefCounted, seed: String, outcome: String) -> Dictionary:
	return {"seed": seed, "outcome": outcome, "floor": game.floor_num, "turns": game.turn, "kills": game.kills, "gold": game.player.gold, "level": game.player.level}
