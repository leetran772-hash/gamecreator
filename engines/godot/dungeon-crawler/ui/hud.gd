# UI/HUD kit (Godot port of src/engines/three/hud.ts): HP bar, stats line,
# inventory panel, combat log, help line and game-over overlay. Driven only by
# events from the core (message, playerHealthChanged, inventoryChanged,
# floorChanged, enemyDefeated, itemPickedUp, gameOver).
extends CanvasLayer

signal restart_requested

const C_TEXT := Color("#e9e3d4")
const C_MUTED := Color("#9b94a3")
const C_PANEL := Color(0.055, 0.051, 0.071, 0.78)
const C_HP := Color("#9c2a2a")
const C_ACCENT := Color("#e0782c")
const C_GOLD := Color("#e8b54a")
const C_BORDER := Color("#4a4651")

var game: RefCounted
var lines: Array[String] = []

var title_label: Label
var stats_label: Label
var hp_bar: ProgressBar
var hp_label: Label
var inventory_box: VBoxContainer
var log_label: RichTextLabel
var help_label: Label
var overlay: Control
var overlay_title: Label
var overlay_text: Label


func _ready() -> void:
	var root := Control.new()
	root.set_anchors_preset(Control.PRESET_FULL_RECT)
	root.mouse_filter = Control.MOUSE_FILTER_IGNORE
	root.theme = _theme()
	add_child(root)

	var top := HBoxContainer.new()
	top.position = Vector2(12, 12)
	top.add_theme_constant_override("separation", 12)
	root.add_child(top)
	title_label = _label(C_ACCENT, 16)
	top.add_child(title_label)
	hp_bar = ProgressBar.new()
	hp_bar.custom_minimum_size = Vector2(200, 18)
	hp_bar.show_percentage = false
	hp_bar.add_theme_stylebox_override("background", _box(C_PANEL, C_BORDER))
	hp_bar.add_theme_stylebox_override("fill", _box(C_HP, C_HP))
	hp_label = _label(C_TEXT, 12)
	hp_label.set_anchors_preset(Control.PRESET_FULL_RECT)
	hp_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	hp_label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	hp_bar.add_child(hp_label)
	top.add_child(hp_bar)
	stats_label = _label(C_MUTED, 14)
	top.add_child(stats_label)

	var inv_panel := PanelContainer.new()
	inv_panel.add_theme_stylebox_override("panel", _box(C_PANEL, Color.TRANSPARENT, 8))
	inv_panel.set_anchors_preset(Control.PRESET_TOP_RIGHT)
	inv_panel.offset_left = -242
	inv_panel.offset_right = -12
	inv_panel.offset_top = 52
	inv_panel.custom_minimum_size = Vector2(230, 0)
	root.add_child(inv_panel)
	inventory_box = VBoxContainer.new()
	inv_panel.add_child(inventory_box)

	var log_panel := PanelContainer.new()
	log_panel.add_theme_stylebox_override("panel", _box(C_PANEL, Color.TRANSPARENT, 8))
	log_panel.set_anchors_preset(Control.PRESET_BOTTOM_LEFT)
	log_panel.offset_left = 12
	log_panel.offset_right = 532
	log_panel.offset_top = -210
	log_panel.offset_bottom = -36
	root.add_child(log_panel)
	log_label = RichTextLabel.new()
	log_label.bbcode_enabled = true
	log_label.fit_content = false
	log_label.scroll_active = false
	log_label.scroll_following = true
	log_label.add_theme_color_override("default_color", C_TEXT)
	log_panel.add_child(log_label)

	help_label = _label(C_MUTED, 12)
	help_label.set_anchors_preset(Control.PRESET_BOTTOM_LEFT)
	help_label.offset_left = 12
	help_label.offset_top = -28
	root.add_child(help_label)

	overlay = ColorRect.new()
	(overlay as ColorRect).color = Color(0, 0, 0, 0.6)
	overlay.set_anchors_preset(Control.PRESET_FULL_RECT)
	overlay.visible = false
	root.add_child(overlay)
	var center := CenterContainer.new()
	center.set_anchors_preset(Control.PRESET_FULL_RECT)
	overlay.add_child(center)
	var box := VBoxContainer.new()
	box.alignment = BoxContainer.ALIGNMENT_CENTER
	box.add_theme_constant_override("separation", 12)
	center.add_child(box)
	overlay_title = _label(C_ACCENT, 28)
	overlay_title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	box.add_child(overlay_title)
	overlay_text = _label(C_TEXT, 14)
	overlay_text.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	box.add_child(overlay_text)
	var again := Button.new()
	again.name = "Restart"
	again.text = "New run (R)"
	again.add_theme_stylebox_override("normal", _box(C_ACCENT, C_ACCENT, 8))
	again.add_theme_color_override("font_color", Color("#111111"))
	again.pressed.connect(func() -> void: restart_requested.emit())
	box.add_child(again)


## Attach to a new game: clears the log and subscribes to its events.
func bind(p_game: RefCounted, help: String) -> void:
	game = p_game
	title_label.text = game.bible.meta.title
	help_label.text = help
	overlay.visible = false
	lines.clear()
	var ev: RefCounted = game.events
	ev.on("message", _on_message)
	ev.on("playerHealthChanged", _on_stats)
	ev.on("inventoryChanged", _on_inventory)
	ev.on("floorChanged", _on_stats)
	ev.on("enemyDefeated", _on_stats)
	ev.on("itemPickedUp", _on_stats)
	ev.on("gameOver", _on_game_over)
	log_text("You enter %s. Find the glowing stairs." % game.bible.meta.title)
	_on_stats({})
	_on_inventory({})


func log_text(text: String) -> void:
	lines.push_front(text)
	if lines.size() > 8:
		lines.resize(8)
	var out := PackedStringArray()
	# Newest at the bottom, older lines fade.
	for i in range(lines.size() - 1, -1, -1):
		var alpha := 0.9 if i < 3 else 0.55
		out.append("[color=#e9e3d4%02x]%s[/color]" % [int(alpha * 255), lines[i].replace("[", "[lb]")])
	log_label.text = "\n".join(out)


func _on_message(e: Dictionary) -> void:
	log_text(e.text)


func _on_stats(_e: Dictionary) -> void:
	var p = game.player
	stats_label.text = "Floor %d/%d · Lv %d · AC %d · ATK +%d (%s) · %d gold · seed %s" % [game.floor_num, int(game.desc.floors), p.level, p.ac, p.attack_bonus, p.damage, p.gold, game.seed]
	hp_bar.max_value = p.max_hp
	hp_bar.value = maxi(0, p.hp)
	hp_label.text = "HP %d / %d" % [maxi(0, p.hp), p.max_hp]


func _on_inventory(_e: Dictionary) -> void:
	for c in inventory_box.get_children():
		c.queue_free()
	var inv: RefCounted = game.inventory
	inventory_box.add_child(_header("EQUIPPED"))
	var any := false
	for slot in ["weapon", "armor"]:
		if inv.equipped.has(slot):
			inventory_box.add_child(_label(C_GOLD, 14, _item_name(inv.equipped[slot].itemId)))
			any = true
	if not any:
		inventory_box.add_child(_label(C_TEXT, 14, "—"))
	inventory_box.add_child(_header("PACK %d/%d" % [inv.items.size(), inv.capacity]))
	for i in inv.items.size():
		inventory_box.add_child(_label(C_TEXT, 14, "%d  %s" % [i + 1, _item_name(inv.items[i].itemId)]))
	if inv.items.is_empty():
		inventory_box.add_child(_label(C_TEXT, 14, "empty"))


func _on_game_over(e: Dictionary) -> void:
	overlay_title.text = "You escaped" if e.won else "You died"
	overlay_text.text = "Floor %d · turn %d · %d kills · %d gold · seed \"%s\"" % [e.floor, e.turn, game.kills, game.player.gold, game.seed]
	overlay.visible = true


func _item_name(item_id: String) -> String:
	var it: Dictionary = game.item(item_id)
	return "%s %s" % [it.icon, it.name]


func _header(text: String) -> Label:
	var l := _label(C_MUTED, 12, text)
	return l


func _label(color: Color, size: int, text: String = "") -> Label:
	var l := Label.new()
	l.text = text
	l.add_theme_color_override("font_color", color)
	l.add_theme_font_size_override("font_size", size)
	l.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return l


func _box(bg: Color, border: Color, pad: int = 0) -> StyleBoxFlat:
	var s := StyleBoxFlat.new()
	s.bg_color = bg
	s.border_color = border
	s.set_border_width_all(1 if border.a > 0 else 0)
	s.set_corner_radius_all(4)
	s.set_content_margin_all(pad)
	return s


func _theme() -> Theme:
	var t := Theme.new()
	var mono := SystemFont.new()
	mono.font_names = PackedStringArray(["DejaVu Sans Mono", "Menlo", "Consolas", "monospace"])
	var emoji := SystemFont.new()
	emoji.font_names = PackedStringArray(["Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji"])
	mono.fallbacks = [emoji]
	t.default_font = mono
	t.default_font_size = 14
	return t
