# Loads the project's element bible layers and engine-neutral game description
# at runtime. The exporter writes them to res://data/ (meta.json, visual.json,
# audio.json, lore.json, code.json, game.json). A project folder layout
# (<dir>/bible/*.json + <dir>/game.json) is accepted too, which the parity
# check uses to read projects/<name>/ directly.
extends RefCounted

const LAYERS := ["meta", "visual", "audio", "lore", "code"]


static func _read_json(path: String) -> Variant:
	var text := FileAccess.get_file_as_string(path)
	if text == "":
		push_error("Cannot read %s (%s)" % [path, error_string(FileAccess.get_open_error())])
		return null
	var parsed = JSON.parse_string(text)
	if parsed == null:
		push_error("Bad JSON in %s" % path)
	return _intify(parsed)


## JSON numbers arrive as floats; whole numbers become ints so stats print and
## compare like they do in TypeScript ("3", not "3.0").
static func _intify(v: Variant) -> Variant:
	match typeof(v):
		TYPE_FLOAT:
			return int(v) if v == floorf(v) and absf(v) < 9.0e15 else v
		TYPE_ARRAY:
			var a: Array = []
			for x in v:
				a.append(_intify(x))
			return a
		TYPE_DICTIONARY:
			var d := {}
			for k in v:
				d[k] = _intify(v[k])
			return d
	return v


## Returns {"bible": {meta, visual, audio, lore, code}, "desc": game.json}.
static func load_project(dir: String = "res://data") -> Dictionary:
	var layer_dir := dir
	if FileAccess.file_exists(dir.path_join("bible/meta.json")):
		layer_dir = dir.path_join("bible")
	var bible := {}
	for layer in LAYERS:
		bible[layer] = _read_json(layer_dir.path_join(layer + ".json"))
	return {"bible": bible, "desc": _read_json(dir.path_join("game.json"))}
