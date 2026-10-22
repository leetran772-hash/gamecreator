# Visual check: renders the main scene and saves a PNG for review against the
# bible. Needs a display (headless mode cannot render), e.g.:
#   xvfb-run -a godot --path <project> --rendering-driver opengl3 --script res://qa/screenshot.gd -- \
#     --out /abs/path/shot.png [--seed visual-1] [--turns 60] [--frames 30]
extends SceneTree

const Playtest := preload("res://qa/playtest.gd")

var main: Node
var frame := 0
var args: Dictionary


func _initialize() -> void:
	args = Playtest.parse_args()
	main = (load("res://scenes/main.tscn") as PackedScene).instantiate()
	root.add_child(main)


func _process(_delta: float) -> bool:
	frame += 1
	if frame == 2:
		if args.has("seed"):
			main.start(main.Game.new(main.bible, main.desc, args.seed))
		for i in int(args.get("turns", "60")):
			main.bot_step()
	if frame < int(args.get("frames", "30")):
		return false
	var img := root.get_texture().get_image()
	var out: String = args.get("out", "user://screenshot.png")
	var err := img.save_png(out)
	print("SCREENSHOT_JSON " + JSON.stringify({"path":ProjectSettings.globalize_path(out), "ok": err == OK, "size": [img.get_width(), img.get_height()], "renderer": RenderingServer.get_video_adapter_name()}))
	return true
