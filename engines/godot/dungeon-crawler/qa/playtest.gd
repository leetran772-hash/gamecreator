# Headless bot playtest for the Godot build.
#   godot --headless --path <project> --script res://qa/playtest.gd -- --runs 200 [--data <dir>] [--seed-prefix playtest-]
# Prints one line "PLAYTEST_JSON {...}" to stdout: win rate, deaths by floor,
# averages, per-run results and issues (crash, softlock, unreachable).
# Exit code 0 even with issues; scripts/godot-qa.ts decides pass/fail.
extends SceneTree

const Bible := preload("res://core/bible.gd")
const Bot := preload("res://qa/bot.gd")


## GDScript has no exceptions: runtime errors are logged and the call returns.
## Godot 4.5's Logger lets us count them so a run that errors counts as a crash.
class ErrorCounter extends Logger:
	var count := 0
	var last := ""

	func _log_error(function: String, file: String, line: int, code: String, rationale: String, _editor_notify: bool, error_type: int, _backtraces: Array[ScriptBacktrace]) -> void:
		if error_type == ERROR_TYPE_WARNING:
			return
		count += 1
		last = "%s at %s:%d (%s)" % [rationale if rationale != "" else code, file, line, function]

	func _log_message(_message: String, _error: bool) -> void:
		pass


static func parse_args() -> Dictionary:
	var args := {}
	var list := OS.get_cmdline_user_args()
	var i := 0
	while i < list.size():
		var a: String = list[i]
		if a.begins_with("--"):
			var key := a.substr(2)
			if i + 1 < list.size() and not list[i + 1].begins_with("--"):
				args[key] = list[i + 1]
				i += 1
			else:
				args[key] = "true"
		i += 1
	return args


func _initialize() -> void:
	var args := parse_args()
	var project := Bible.load_project(args.get("data", "res://data"))
	var bible: Dictionary = project.bible
	var desc: Dictionary = project.desc
	var runs := int(args.get("runs", str(desc.qa.playtestRuns)))
	var prefix: String = args.get("seed-prefix", "playtest-")
	var errors := ErrorCounter.new()
	OS.add_logger(errors)

	var issues: Array = []
	var results: Array = []
	var t0 := Time.get_ticks_msec()
	for i in runs:
		results.append(Bot.play_run(bible, desc, "%s%d" % [prefix, i], issues, errors))
	var won := 0
	var deaths := {}
	var totals := {"turns": 0, "kills": 0, "gold": 0}
	for r in results:
		if r.outcome == "won":
			won += 1
		if r.outcome == "dead":
			deaths[str(r.floor)] = deaths.get(str(r.floor), 0) + 1
		for k in totals:
			totals[k] += r[k]
	var counts := {"crash": 0, "softlock": 0, "unreachable": 0}
	for issue in issues:
		counts[issue.kind] += 1
	var report := {
		"engine": "godot",
		"godot": Engine.get_version_info().string,
		"title": bible.meta.title,
		"runs": runs,
		"winRate": float(won) / maxf(1.0, runs),
		"deathsByFloor": deaths,
		"avgTurns": float(totals.turns) / maxf(1.0, runs),
		"avgKills": float(totals.kills) / maxf(1.0, runs),
		"avgGold": float(totals.gold) / maxf(1.0, runs),
		"issueCounts": counts,
		"issues": issues,
		"results": results,
		"ms": Time.get_ticks_msec() - t0,
	}
	OS.remove_logger(errors)
	print("PLAYTEST_JSON " + JSON.stringify(report))
	quit(0)
