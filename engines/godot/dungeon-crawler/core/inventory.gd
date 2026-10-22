# Inventory. Uses the shared item schema; receives loot roller drops via
# itemPickedUp and announces every change with inventoryChanged.
# Port of src/core/inventory.ts. Instances are {uid, itemId}.
extends RefCounted

var capacity: int
var items: Array = []
## {"weapon": inst, "armor": inst}; a missing key means the slot is empty.
var equipped := {}
var _lookup: Callable
var _on_change: Callable


func _init(p_capacity: int, lookup: Callable, on_change: Callable) -> void:
	capacity = p_capacity
	_lookup = lookup
	_on_change = on_change


func is_full() -> bool:
	return items.size() >= capacity


func add(item: Dictionary) -> bool:
	if is_full():
		return false
	items.append(item)
	_changed()
	return true


func remove(uid: String) -> Variant:
	for i in items.size():
		if items[i].uid == uid:
			var removed: Dictionary = items[i]
			items.remove_at(i)
			_changed()
			return removed
	return null


func find(uid: String) -> Variant:
	for it in items:
		if it.uid == uid:
			return it
	return null


## Equips a weapon or armor from the bag; the old one goes back into the bag.
func equip(uid: String) -> bool:
	var inst = find(uid)
	if inst == null:
		return false
	var kind: String = _lookup.call(inst.itemId).kind
	if kind != "weapon" and kind != "armor":
		return false
	items = items.filter(func(it): return it.uid != uid)
	if equipped.has(kind):
		items.append(equipped[kind])
	equipped[kind] = inst
	_changed()
	return true


func snapshot() -> Dictionary:
	return {"items": items.duplicate(), "equipped": equipped.duplicate(), "capacity": capacity}


func _changed() -> void:
	_on_change.call(snapshot())
