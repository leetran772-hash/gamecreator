# Saves, per the bible's code.godot.saves convention: the seed, floor, turn and
# inventory go to user://save.json and the floor is regenerated from the seed.
extends RefCounted

const Game := preload("res://core/game.gd")
const DEFAULT_PATH := "user://save.json"


static func save(game: RefCounted, path: String = DEFAULT_PATH) -> bool:
	var f := FileAccess.open(path, FileAccess.WRITE)
	if f == null:
		push_warning("Cannot write %s: %s" % [path, error_string(FileAccess.get_open_error())])
		return false
	f.store_string(JSON.stringify(game.to_save(), "  "))
	return true


static func exists(path: String = DEFAULT_PATH) -> bool:
	return FileAccess.file_exists(path)


## Returns a Game, or null when there is no (valid) save.
static func load_game(bible: Dictionary, desc: Dictionary, path: String = DEFAULT_PATH) -> RefCounted:
	if not FileAccess.file_exists(path):
		return null
	var data = JSON.parse_string(FileAccess.get_file_as_string(path))
	if typeof(data) != TYPE_DICTIONARY or not data.has("seed") or not data.has("floor"):
		push_warning("Ignoring invalid save at %s" % path)
		return null
	return Game.from_save(bible, desc, data)
