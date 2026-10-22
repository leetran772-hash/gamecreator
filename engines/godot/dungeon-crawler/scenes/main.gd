# Godot renderer for the dungeon crawler. Reads state from the engine-neutral
# core (core/game.gd, fed by the bible + game.json in res://data/), renders it
# top-down like the Three.js preview, and forwards input as core actions.
# Uses the bible's GLB models when an entity has a `model` path, otherwise
# primitives; materials come from the bible's visual palette.
#   Command line (after --): --seed <seed>  --continue (load user://save.json)
extends Node3D

const Bible := preload("res://core/bible.gd")
const Game := preload("res://core/game.gd")
const Level := preload("res://core/level.gd")
const Save := preload("res://core/save.gd")
const Bot := preload("res://qa/bot.gd")
const Hud := preload("res://ui/hud.gd")
const EntityScene := preload("res://scenes/entity.tscn")

const MOVES := {"move_up": Vector2i(0, -1), "move_down": Vector2i(0, 1), "move_left": Vector2i(-1, 0), "move_right": Vector2i(1, 0)}

var bible: Dictionary
var desc: Dictionary
var game: RefCounted
var hud: CanvasLayer
var seed := ""

var world: Node3D
var camera: Camera3D
var sun: DirectionalLight3D
var torch: OmniLight3D
var materials := {}
var model_cache := {}  # path -> PackedScene | Node3D template | null
var models_loaded: Array[String] = []
var entities := {}  # uid -> entity node
var floor_shown := 0
var help_text := ""


func _ready() -> void:
	var project := Bible.load_project()
	if project.bible.meta == null or project.desc == null:
		var l := Label.new()
		l.text = "No game data in res://data/. Export a project with:\n  npx tsx scripts/export-godot.ts --project projects/<name>"
		add_child(l)
		return
	bible = project.bible
	desc = project.desc
	get_window().title = bible.meta.title
	help_text = setup_input(bible.code.godot.controls)
	_build_environment()
	world = Node3D.new()
	world.name = "World"
	add_child(world)
	hud = Hud.new()
	hud.name = "Hud"
	add_child(hud)
	hud.restart_requested.connect(restart)

	var args := _args()
	seed = args.get("seed", String(desc.defaultSeed))
	if args.has("continue") and Save.exists():
		start(Save.load_game(bible, desc))
	else:
		start(Game.new(bible, desc, seed))


# --- input (bible code.godot.controls) --------------------------------------

## Builds InputMap actions from the bible's control names ("WASD", "arrows",
## "Space", "Enter", "1-9", or any single key name). Returns the help line.
static func setup_input(controls: Dictionary) -> String:
	var help := PackedStringArray()
	for control in controls:
		var tokens: Array = controls[control]
		for token in tokens:
			match token:
				"WASD":
					_bind("move_up", KEY_W); _bind("move_left", KEY_A); _bind("move_down", KEY_S); _bind("move_right", KEY_D)
				"arrows":
					_bind("move_up", KEY_UP); _bind("move_left", KEY_LEFT); _bind("move_down", KEY_DOWN); _bind("move_right", KEY_RIGHT)
				"Enter":
					_bind(control, KEY_ENTER); _bind(control, KEY_KP_ENTER)
				_:
					var range_parts: PackedStringArray = String(token).split("-")
					if range_parts.size() == 2 and range_parts[0].is_valid_int() and range_parts[1].is_valid_int():
						for n in range(int(range_parts[0]), int(range_parts[1]) + 1):
							_bind("%s_%d" % [control, n], KEY_0 + n)
					else:
						var code := OS.find_keycode_from_string(token)
						if code != KEY_NONE:
							_bind(control, code)
						else:
							push_warning("Unknown key \"%s\" for control %s" % [token, control])
		help.append("%s %s" % ["/".join(PackedStringArray(tokens)), control])
	_bind("save", KEY_F5)
	_bind("load", KEY_F9)
	_bind("restart", KEY_R)
	help.append("F5 save · F9 load")
	return " · ".join(help)


static func _bind(action: String, key: Key) -> void:
	if not InputMap.has_action(action):
		InputMap.add_action(action)
	var ev := InputEventKey.new()
	ev.physical_keycode = key
	for existing in InputMap.action_get_events(action):
		if existing is InputEventKey and existing.physical_keycode == key:
			return
	InputMap.action_add_event(action, ev)


func _unhandled_input(event: InputEvent) -> void:
	if game == null or not event.is_pressed() or event.is_echo():
		return
	for action in MOVES:
		if event.is_action(action):
			game.act({"type": "move", "dx": MOVES[action].x, "dy": MOVES[action].y})
			return
	if event.is_action("wait"):
		game.act({"type": "wait"})
	elif event.is_action("descend"):
		game.act({"type": "descend"})
	elif event.is_action("save"):
		if Save.save(game):
			hud.log_text("Game saved.")
	elif event.is_action("load"):
		var loaded := Save.load_game(bible, desc)
		if loaded:
			start(loaded)
			hud.log_text("Game loaded (floor regenerated from seed \"%s\")." % loaded.seed)
	elif event.is_action("restart") and game.status != "playing":
		restart()
	else:
		for n in range(1, 10):
			if InputMap.has_action("use_%d" % n) and event.is_action("use_%d" % n):
				if n - 1 < game.inventory.items.size():
					game.act({"type": "use", "uid": game.inventory.items[n - 1].uid})
				return


# --- runs -------------------------------------------------------------------

func start(g: RefCounted) -> void:
	game = g
	seed = game.seed
	hud.bind(game, help_text)
	game.events.on("floorChanged", func(_e): Save.save(game))  # autosave on each new floor
	floor_shown = 0
	sync(0.0, true)


func restart() -> void:
	var base := RegEx.create_from_string("-r\\d+$").sub(seed, "")
	start(Game.new(bible, desc, "%s-r%d" % [base, Time.get_ticks_msec() % 100000]))


## One bot move (used by qa/smoke.gd and handy for demos).
func bot_step() -> bool:
	return game.act(Bot.bot_action(game))


# --- scene ------------------------------------------------------------------

func color(key: String) -> Color:
	assert(bible.visual.palette.has(key), "Palette has no \"%s\"" % key)
	return Color(bible.visual.palette[key])


func material(key: String) -> StandardMaterial3D:
	if materials.has(key):
		return materials[key]
	var def: Dictionary = bible.visual.materials[key]
	var m := StandardMaterial3D.new()
	m.albedo_color = color(def.color)
	m.roughness = float(def.roughness)
	m.metallic = float(def.metalness)
	if def.has("emissive"):
		m.emission_enabled = true
		m.emission = color(def.emissive)
		m.emission_energy_multiplier = 0.35
	materials[key] = m
	return m


func _build_environment() -> void:
	var env := Environment.new()
	env.background_mode = Environment.BG_COLOR
	env.background_color = color("void")
	env.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.ambient_light_color = Color("#b8b0c8")
	env.ambient_light_energy = 0.4
	env.fog_enabled = true
	# Linear depth fog, like the Three.js preview's Fog(void, 16, 34).
	env.fog_mode = Environment.FOG_MODE_DEPTH
	env.fog_light_color = color("void")
	env.fog_density = 1.0
	env.fog_depth_begin = 16.0
	env.fog_depth_end = 34.0
	env.fog_depth_curve = 1.0
	env.tonemap_mode = Environment.TONE_MAPPER_FILMIC
	var we := WorldEnvironment.new()
	we.environment = env
	add_child(we)
	sun = DirectionalLight3D.new()
	sun.light_color = Color("#ffe2c0")
	sun.light_energy = 0.55
	sun.shadow_enabled = true
	sun.directional_shadow_max_distance = 40.0
	add_child(sun)
	torch = OmniLight3D.new()
	torch.light_color = color("ember")
	torch.light_energy = 1.4
	torch.omni_range = 9.0
	torch.omni_attenuation = 1.6
	add_child(torch)
	camera = Camera3D.new()
	camera.fov = 50.0
	camera.near = 0.1
	camera.far = 200.0
	add_child(camera)
	camera.make_current()


func build_floor() -> void:
	for c in world.get_children():
		c.queue_free()
	entities.clear()
	var l: RefCounted = game.level
	var floors: Array[Vector2i] = []
	var walls: Array[Vector2i] = []
	for y in range(-1, l.height + 1):
		for x in range(-1, l.width + 1):
			if l.tile_at(x, y) != Level.WALL:
				floors.append(Vector2i(x, y))
				continue
			# Only walls that touch a floor tile.
			var edge := false
			for dy in range(-1, 2):
				for dx in range(-1, 2):
					if l.tile_at(x + dx, y + dy) != Level.WALL:
						edge = true
			if edge:
				walls.append(Vector2i(x, y))
	world.add_child(_tiles("Floor", floors, Vector3(1, 0.2, 1), -0.1, material("floor")))
	world.add_child(_tiles("Walls", walls, Vector3(1, 0.9, 1), 0.45, material("wall")))
	var stairs := MeshInstance3D.new()
	stairs.name = "Stairs"
	var cyl := CylinderMesh.new()
	cyl.top_radius = 0.42
	cyl.bottom_radius = 0.42
	cyl.height = 0.06
	cyl.radial_segments = 16
	stairs.mesh = cyl
	stairs.material_override = material("stairs")
	stairs.position = Vector3(l.stairs.x, 0.03, l.stairs.y)
	world.add_child(stairs)
	floor_shown = game.floor_num


func _tiles(node_name: String, cells: Array[Vector2i], size: Vector3, y: float, mat: Material) -> MultiMeshInstance3D:
	var box := BoxMesh.new()
	box.size = size
	box.material = mat
	var mm := MultiMesh.new()
	mm.transform_format = MultiMesh.TRANSFORM_3D
	mm.mesh = box
	mm.instance_count = cells.size()
	for i in cells.size():
		mm.set_instance_transform(i, Transform3D(Basis(), Vector3(cells[i].x, y, cells[i].y)))
	var mmi := MultiMeshInstance3D.new()
	mmi.name = node_name
	mmi.multimesh = mm
	return mmi


## The GLB at a bible `model` path, or null. Imported projects load the native
## resource; a freshly exported (not yet imported) project parses the GLB at
## runtime with GLTFDocument.
func load_model(path: Variant) -> Node3D:
	if path == null or String(path) == "":
		return null
	var res_path := "res://" + String(path).trim_prefix("./")
	if not model_cache.has(res_path):
		var template: Variant = null
		if ResourceLoader.exists(res_path):
			template = load(res_path)
		elif FileAccess.file_exists(res_path):
			var doc := GLTFDocument.new()
			var state := GLTFState.new()
			if doc.append_from_file(res_path, state) == OK:
				template = doc.generate_scene(state)
		if template == null:
			push_warning("Model %s failed to load, keeping primitive" % res_path)
		else:
			models_loaded.append(String(path))
		model_cache[res_path] = template
	var t: Variant = model_cache[res_path]
	if t is PackedScene:
		return (t as PackedScene).instantiate()
	if t is Node3D:
		return (t as Node3D).duplicate()
	return null


func _entity(uid: String, kind: String, def_id: String, mat_key: String, model_path: Variant, grid: Vector2i) -> Node3D:
	var e: Node3D = entities.get(uid)
	if e == null:
		e = EntityScene.instantiate()
		world.add_child(e)
		e.setup(uid, kind, def_id, material(mat_key), load_model(model_path))
		e.place(grid, true)
		entities[uid] = e
	else:
		e.place(grid, kind == "item")
	return e


func sync(delta: float, snap_camera: bool = false) -> void:
	if game == null:
		return
	if floor_shown != game.floor_num:
		build_floor()
	var alive := {}
	var p = game.player
	var lp: Dictionary = bible.lore.player
	_entity("player", "player", "player", lp.material, lp.get("model"), p.pos)
	alive["player"] = true
	for e in game.enemies:
		var def: Dictionary = bible.lore.bestiary[e.def_id]
		_entity(e.uid, "enemy", e.def_id, def.material, def.get("model"), e.pos)
		alive[e.uid] = true
	for g in game.ground:
		var it: Dictionary = game.item(g.item.itemId)
		_entity(g.item.uid, "item", g.item.itemId, "loot", it.get("model"), g.pos)
		alive[g.item.uid] = true
	for uid in entities.keys():
		if not alive.has(uid):
			entities[uid].queue_free()
			entities.erase(uid)

	var po: Node3D = entities["player"]
	torch.position = Vector3(po.position.x, 1.6, po.position.z)
	var target := Vector3(po.position.x, 0, po.position.z)
	var want := Vector3(target.x, 13, target.z + 8)
	camera.position = want if snap_camera else camera.position.lerp(want, 1.0 - pow(0.001, delta))
	camera.look_at(Vector3(camera.position.x, 0, camera.position.z - 8), Vector3.UP)
	sun.look_at_from_position(target + Vector3(-8, 20, 6), target, Vector3.UP)


func _process(delta: float) -> void:
	sync(minf(delta, 0.1))


func _exit_tree() -> void:
	# GLB templates parsed at runtime live outside the tree; free them.
	for t in model_cache.values():
		if t is Node:
			t.free()
	model_cache.clear()


func _args() -> Dictionary:
	var out := {}
	var list := OS.get_cmdline_user_args()
	for i in list.size():
		if list[i].begins_with("--"):
			out[list[i].substr(2)] = list[i + 1] if i + 1 < list.size() and not list[i + 1].begins_with("--") else "true"
	return out
