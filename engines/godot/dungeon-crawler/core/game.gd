# Engine-neutral turn-based dungeon crawler, GDScript port of src/core/game.ts.
# Wires seeder + level design + combat + loot roller + inventory together
# through shared events. The renderer and HUD only read state, call act(), and
# listen to `events`. Same stream names, draw order and event order as the
# TypeScript core: tests/godot.test.ts checks both give identical runs.
extends RefCounted

const Seeder := preload("res://core/seeder.gd")
const Level := preload("res://core/level.gd")
const Combat := preload("res://core/combat.gd")
const Loot := preload("res://core/loot.gd")
const Inventory := preload("res://core/inventory.gd")
const Events := preload("res://core/events.gd")


class Actor:
	var uid: String
	var def_id: String
	var name: String
	var pos: Vector2i
	var hp: int
	var max_hp: int
	var ac: int
	var attack_bonus: int
	var damage: String
	var sight_range: int
	var awake: bool
	# Player only.
	var xp := 0
	var level := 1
	var gold := 0

	func _init(p_uid: String, p_def_id: String, stats: Dictionary, p_sight_range: int, p_awake: bool) -> void:
		uid = p_uid
		def_id = p_def_id
		name = stats.name
		hp = int(stats.hp)
		max_hp = int(stats.hp)
		ac = int(stats.ac)
		attack_bonus = int(stats.attackBonus)
		damage = stats.damage
		sight_range = p_sight_range
		awake = p_awake


var events := Events.new()
var bible: Dictionary
var desc: Dictionary
var rng: RefCounted
var inventory: RefCounted

# State (mirrors GameState in TypeScript; `floor_num` because floor() is a builtin).
var seed: String
var floor_num := 0
var turn := 0
var turns_on_floor := 0
var level: RefCounted
var player: Actor
var enemies: Array = []  # of Actor
var ground: Array = []  # of {item: {uid, itemId}, pos: Vector2i}
var status := "playing"  # playing | dead | won
var kills := 0

var _combat_rng: RefCounted
var _next_item_uid := 0


func _init(p_bible: Dictionary, p_desc: Dictionary, p_seed: String = "") -> void:
	bible = p_bible
	desc = p_desc
	seed = p_seed if p_seed != "" else String(desc.defaultSeed)
	rng = Seeder.new(seed)
	inventory = Inventory.new(int(desc.player.inventoryCapacity), item, _on_inventory_changed)
	var p: Dictionary = bible.lore.player
	player = Actor.new("player", "player", p, 0, true)

	# Loot roller listens to combat; inventory receives pickups. Bound methods,
	# not lambdas: a lambda would capture self and leak the Game via a cycle.
	events.on("enemyDefeated", _on_enemy_defeated)
	events.on("itemPickedUp", _on_item_picked_up)

	for id in desc.player.startingItems:
		var inst := _new_item(id)
		inventory.add(inst)
		var kind: String = item(id).kind
		if kind == "weapon" or kind == "armor":
			inventory.equip(inst.uid)
	_apply_equipment()
	enter_floor(1)


func _on_inventory_changed(snap: Dictionary) -> void:
	events.emit("inventoryChanged", snap)


func _on_enemy_defeated(e: Dictionary) -> void:
	var def = bible.lore.bestiary.get(e.enemyId)
	var table = bible.lore.lootTables.get(def.lootTable) if def else null
	if table == null:
		return
	for drop in Loot.roll_loot(rng.fork("loot:%s" % e.enemyUid), table, "loot-%s" % e.enemyUid):
		ground.append({"item": drop, "pos": e.position})
		events.emit("lootDropped", {"item": drop, "position": e.position, "sourceUid": e.enemyUid})


func _on_item_picked_up(e: Dictionary) -> void:
	var it := item(e.item.itemId)
	if it.kind == "treasure":
		var value := int(it.stats.get("value", 0))
		player.gold += value
		_say("You pocket %s (+%d gold)." % [it.name, value])
		return
	inventory.add(e.item)
	_say("You pick up %s." % it.name)


func item(id: String) -> Dictionary:
	var it = bible.lore.items.get(id)
	assert(it != null, "Unknown item \"%s\"" % id)
	return it


## One player action, then every enemy acts. Returns false if the action was not possible.
## action: {"type": "move", "dx", "dy"} | {"type": "wait"} | {"type": "use", "uid"} | {"type": "descend"}
func act(action: Dictionary) -> bool:
	if status != "playing":
		return false
	var floor_before: int = floor_num
	if not _player_act(action):
		return false
	# Arriving on a new floor gives the player a free turn (no hit on arrival).
	if status == "playing" and floor_num == floor_before:
		_enemies_act()
	turn += 1
	turns_on_floor += 1
	return true


func enemy_at(x: int, y: int) -> Actor:
	for e in enemies:
		if e.pos.x == x and e.pos.y == y:
			return e
	return null


func _player_act(action: Dictionary) -> bool:
	var p := player
	match action.type:
		"wait":
			return true
		"descend":
			if p.pos != level.stairs:
				return false
			if floor_num >= int(desc.floors):
				status = "won"
				_say("You escape the depths!")
				events.emit("gameOver", {"won": true, "floor": floor_num, "turn": turn})
			else:
				enter_floor(floor_num + 1)
			return true
		"use":
			return _use_item(action.uid)
		"move":
			var nx: int = p.pos.x + signi(int(action.dx))
			var ny: int = p.pos.y + signi(int(action.dy))
			if absi(nx - p.pos.x) + absi(ny - p.pos.y) != 1:
				return false
			var enemy := enemy_at(nx, ny)
			if enemy:
				_attack(p, enemy)
				return true
			if not level.is_floor(nx, ny):
				return false
			p.pos = Vector2i(nx, ny)
			_pick_up_at(p.pos)
			return true
	return false


func _use_item(uid: String) -> bool:
	var inst = inventory.find(uid)
	if inst == null:
		return false
	var it := item(inst.itemId)
	var p := player
	if it.kind == "potion" and it.stats.get("heal", "") != "":
		if p.hp >= p.max_hp:
			_say("You're already at full health.")
			return false
		var healed := mini(p.max_hp - p.hp, Seeder.roll_dice(rng.fork("heal:%s" % uid), it.stats.heal).total)
		p.hp += healed
		inventory.remove(uid)
		_say("You drink %s and recover %d HP." % [it.name, healed])
		events.emit("playerHealthChanged", {"hp": p.hp, "maxHp": p.max_hp})
		return true
	if inventory.equip(uid):
		_apply_equipment()
		_say("You equip %s." % it.name)
		return true
	return false


func _apply_equipment() -> void:
	var base: Dictionary = bible.lore.player
	var p := player
	var w = item(inventory.equipped.weapon.itemId) if inventory.equipped.has("weapon") else null
	var a = item(inventory.equipped.armor.itemId) if inventory.equipped.has("armor") else null
	p.damage = w.stats.damage if w and w.stats.has("damage") else base.damage
	p.attack_bonus = int(base.attackBonus) + (p.level - 1) + (int(w.stats.get("attackBonus", 0)) if w else 0)
	p.ac = int(a.stats.armorClass) if a and a.stats.has("armorClass") else int(base.ac)


func _pick_up_at(pos: Vector2i) -> void:
	var here := ground.filter(func(g): return g.pos == pos)
	for g in here:
		var it := item(g.item.itemId)
		if it.kind != "treasure" and inventory.is_full():
			_say("Your pack is full; you leave %s." % it.name)
			continue
		ground.erase(g)
		events.emit("itemPickedUp", {"item": g.item, "position": pos})


func _attack(attacker: Actor, defender: Actor) -> void:
	var r := Combat.resolve_attack(_combat_rng, attacker, defender)
	var ev := {"attacker": attacker.uid, "defender": defender.uid}
	ev.merge(r)
	events.emit("attack", ev)
	if r.hit:
		defender.hp -= r.damage
	var verb := "CRITS" if r.crit else ("hits" if r.hit else "misses")
	_say("%s %s %s%s (%d+%d vs AC %d)." % [attacker.name, verb, defender.name, (" for %d" % r.damage) if r.hit else "", r.roll, attacker.attack_bonus, defender.ac])
	if defender.uid == "player":
		events.emit("playerHealthChanged", {"hp": maxi(0, defender.hp), "maxHp": defender.max_hp})
		if defender.hp <= 0:
			status = "dead"
			_say("You die.")
			events.emit("gameOver", {"won": false, "floor": floor_num, "turn": turn})
		return
	if defender.hp <= 0:
		enemies = enemies.filter(func(e): return e != defender)
		kills += 1
		var def: Dictionary = bible.lore.bestiary[defender.def_id]
		events.emit("enemyDefeated", {"enemyUid": defender.uid, "enemyId": defender.def_id, "floor": floor_num, "position": defender.pos, "xp": int(def.xp)})
		_gain_xp(int(def.xp))


func _gain_xp(xp: int) -> void:
	var p := player
	p.xp += xp
	while p.xp >= p.level * int(desc.player.xpPerLevel):
		p.level += 1
		p.max_hp += int(desc.player.hpPerLevel)
		p.hp += int(desc.player.hpPerLevel)
		_apply_equipment()
		_say("You reach level %d!" % p.level)
		events.emit("playerHealthChanged", {"hp": p.hp, "maxHp": p.max_hp})


func _enemies_act() -> void:
	var p := player
	# One distance map from the player, ignoring enemies, drives every chaser.
	# Enemies only read the map at their own tile and at neighbours closer than
	# that, so the search can stop once every enemy tile has been reached.
	var w: int = level.width
	var stop := PackedByteArray()
	stop.resize(w * level.height)
	for e in enemies:
		stop[e.pos.y * w + e.pos.x] = 1
	var dist: PackedInt32Array = level.distance_map(p.pos, PackedByteArray(), stop, 0, true)
	for e in enemies.duplicate():
		if status != "playing":
			return
		var d := absi(e.pos.x - p.pos.x) + absi(e.pos.y - p.pos.y)
		if d == 1:
			e.awake = true
			_attack(e, p)
			continue
		var path_d := dist[e.pos.y * w + e.pos.x]
		if not e.awake and path_d >= 0 and path_d <= e.sight_range:
			e.awake = true
		if not e.awake:
			continue
		var best = null
		var best_d: float = INF if path_d < 0 else float(path_d)
		for dir in Level.DIRS:
			var nx: int = e.pos.x + dir.x
			var ny: int = e.pos.y + dir.y
			if not level.is_floor(nx, ny):
				continue
			var nd := dist[ny * w + nx]
			if nd < 0:
				continue
			if nd < best_d and enemy_at(nx, ny) == null and not (nx == p.pos.x and ny == p.pos.y):
				best_d = nd
				best = Vector2i(nx, ny)
		if best != null:
			e.pos = best


func _new_item(item_id: String, prefix: String = "it") -> Dictionary:
	var inst := {"uid": "%s-%d" % [prefix, _next_item_uid], "itemId": item_id}
	_next_item_uid += 1
	return inst


func enter_floor(f: int) -> void:
	floor_num = f
	turns_on_floor = 0
	level = Level.generate(rng.fork("level:%d" % f), desc.level)
	_combat_rng = rng.fork("combat:%d" % f)
	player.pos = level.start
	enemies = []
	ground = []

	var spawnable: Array = []
	for def in bible.lore.bestiary.values():
		if int(def.minFloor) <= f:
			spawnable.append({"def": def, "weight": def.spawnWeight})
	var min_e := int(desc.spawns.enemiesPerRoom[0])
	var max_e := int(desc.spawns.enemiesPerRoom[1])
	var occupied := {level.start: true, level.stairs: true}
	for ri in level.rooms.size():
		var room: Dictionary = level.rooms[ri]
		# Each room has its own stream: changing one room's spawns leaves the others alone.
		var rr: RefCounted = rng.fork("spawn:%d:%d" % [f, ri])
		if ri > 0:
			var n: int = rr.int_range(min_e, max_e + int(floor((f - 1) / 2.0)))
			for i in n:
				var def: Dictionary = rr.weighted(spawnable).def
				var pos = _free_tile(rr, room, occupied)
				if pos == null:
					continue
				var e := Actor.new("f%dr%de%d" % [f, ri, i], def.id, def, int(def.sightRange), false)
				e.pos = pos
				enemies.append(e)
		if rr.chance(float(desc.spawns.itemChancePerRoom)):
			var table = bible.lore.lootTables.get(desc.spawns.floorItemTable)
			var pos = _free_tile(rr, room, occupied)
			if table != null and pos != null:
				for drop in Loot.roll_loot(rr.fork("item"), table, "f%dr%d" % [f, ri]):
					ground.append({"item": drop, "pos": pos})
	_say(("You enter %s." % bible.meta.title) if f == 1 else ("You descend to floor %d." % f))
	events.emit("floorChanged", {"floor": f})


func _free_tile(rr: RefCounted, room: Dictionary, occupied: Dictionary) -> Variant:
	for tries in 30:
		var pos := Vector2i(rr.int_range(room.x, room.x + room.w - 1), rr.int_range(room.y, room.y + room.h - 1))
		if not occupied.has(pos):
			occupied[pos] = true
			return pos
	return null


func _say(text: String) -> void:
	events.emit("message", {"text": text})


# --- saves (bible code.godot.saves) ------------------------------------------
# Save the seed, floor, turn and inventory; the floor is regenerated from the
# seed on load. Player progression (hp, xp, level, gold) is saved too so a
# loaded run keeps its character.

func to_save() -> Dictionary:
	return {
		"seed": seed,
		"floor": floor_num,
		"turn": turn,
		"inventory": {"items": inventory.items.duplicate(true), "equipped": inventory.equipped.duplicate(true), "nextItemUid": _next_item_uid},
		"player": {"hp": player.hp, "maxHp": player.max_hp, "xp": player.xp, "level": player.level, "gold": player.gold},
		"kills": kills,
	}


static func from_save(p_bible: Dictionary, p_desc: Dictionary, data: Dictionary) -> RefCounted:
	var g: RefCounted = (load("res://core/game.gd") as GDScript).new(p_bible, p_desc, String(data.seed))
	var inv: Dictionary = data.get("inventory", {})
	g.inventory.items = inv.get("items", [])
	g.inventory.equipped = inv.get("equipped", {})
	g._next_item_uid = int(inv.get("nextItemUid", 0))
	var ps: Dictionary = data.get("player", {})
	for key in ["hp", "xp", "level", "gold"]:
		if ps.has(key):
			g.player.set(key, int(ps[key]))
	if ps.has("maxHp"):
		g.player.max_hp = int(ps.maxHp)
	g.kills = int(data.get("kills", 0))
	g._apply_equipment()
	if int(data.floor) != 1:
		g.enter_floor(int(data.floor))
	g.turn = int(data.turn)
	return g
