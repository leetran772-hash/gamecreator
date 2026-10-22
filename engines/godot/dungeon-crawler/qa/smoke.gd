# Headless smoke test of the real main scene: loads it, lets the bot play a
# few turns through the renderer, checks a save/load round trip, and prints
# "SMOKE_JSON {...}" (title, entity count, GLBs loaded, HUD text).
#   godot --headless --path <project> --script res://qa/smoke.gd -- [--frames 5] [--turns 40]
extends SceneTree

const Playtest := preload("res://qa/playtest.gd")
const Save := preload("res://core/save.gd")

var main: Node
var frame := 0
var frames := 5
var turns := 40


func _initialize() -> void:
	var args: Dictionary = Playtest.parse_args()
	frames = int(args.get("frames", "5"))
	turns = int(args.get("turns", "40"))
	main = (load("res://scenes/main.tscn") as PackedScene).instantiate()
	root.add_child(main)


func _process(_delta: float) -> bool:
	frame += 1
	if frame <= frames:
		for i in turns / frames:
			main.bot_step()
		return false
	var g: RefCounted = main.game
	var save_path := "user://smoke-save.json"
	Save.save(g, save_path)
	var loaded: RefCounted = Save.load_game(main.bible, main.desc, save_path)
	DirAccess.remove_absolute(save_path)
	var inv_uids := func(x): return x.inventory.items.map(func(i): return i.uid)
	var report := {
		"title": main.get_window().title,
		"floor": g.floor_num,
		"turn": g.turn,
		"entities": main.entities.size(),
		"floorTiles": main.world.get_node("Floor").multimesh.instance_count,
		"wallTiles": main.world.get_node("Walls").multimesh.instance_count,
		"modelsLoaded": main.models_loaded,
		"hudStats": main.hud.stats_label.text,
		"inputActions": InputMap.get_actions().filter(func(a): return not String(a).begins_with("ui_")),
		"saveRoundTrip": loaded != null and loaded.seed == g.seed and loaded.floor_num == g.floor_num and loaded.turn == g.turn and inv_uids.call(loaded) == inv_uids.call(g),
	}
	print("SMOKE_JSON " + JSON.stringify(report))
	return true
