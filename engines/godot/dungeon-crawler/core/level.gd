# Level design module: seeded room-and-corridor dungeons.
# Port of src/core/level.ts. Rooms are Dictionaries {x, y, w, h}; positions are
# Vector2i. Same draw order as the TypeScript version, so the same seed gives
# the same layout in both engines.
extends RefCounted

const WALL := 0
const FLOOR := 1
const DIRS: Array[Vector2i] = [Vector2i(1, 0), Vector2i(-1, 0), Vector2i(0, 1), Vector2i(0, -1)]

var width: int
var height: int
var tiles: PackedByteArray
var rooms: Array  # of {x, y, w, h}, sorted left to right
var start: Vector2i
var stairs: Vector2i


func tile_at(x: int, y: int) -> int:
	if x < 0 or y < 0 or x >= width or y >= height:
		return WALL
	return tiles[y * width + x]


func is_floor(x: int, y: int) -> bool:
	return tile_at(x, y) == FLOOR


static func room_center(r: Dictionary) -> Vector2i:
	return Vector2i(r.x + int(r.w / 2), r.y + int(r.h / 2))


static func _overlaps(a: Dictionary, b: Dictionary, pad: int) -> bool:
	return a.x - pad < b.x + b.w and a.x + a.w + pad > b.x and a.y - pad < b.y + b.h and a.y + a.h + pad > b.y


## Breadth-first distances from `from` over floor tiles (-1 = unreachable).
## `blocked` is an optional mask (1 = blocked) indexed like `tiles`; it stands
## in for the TypeScript callback and is much faster in GDScript.
## Optional early exit (a GDScript-only optimisation): once the first tile in
## the `stop` mask (or, with stop_all, every tile in it) is reached at distance
## d, tiles farther than d + slack are left at -1. Every tile within d + slack
## still gets its exact distance, so callers that only look that far get the
## same answer as a full search.
func distance_map(from: Vector2i, blocked: PackedByteArray = PackedByteArray(), stop: PackedByteArray = PackedByteArray(), slack: int = 0, stop_all: bool = false) -> PackedInt32Array:
	var n := width * height
	var dist := PackedInt32Array()
	dist.resize(n)
	dist.fill(-1)
	if not is_floor(from.x, from.y):
		return dist
	# Same visiting order as the TypeScript version (DIRS: +x, -x, +y, -y),
	# unrolled because function calls and Vector2i loops are slow in GDScript.
	# A tile is enqueued if it is floor, unvisited and not blocked.
	var w := width
	var t := tiles
	var blk := blocked
	if blk.size() != n:
		blk = PackedByteArray()
		blk.resize(n)  # zero-filled: nothing blocked
	var queue := PackedInt32Array()
	queue.resize(n)
	var start_i := from.y * w + from.x
	queue[0] = start_i
	dist[start_i] = 0
	var has_stop := stop.size() == n
	var limit := 1 << 40
	var remaining := 1
	if has_stop and stop_all:
		remaining = stop.count(1)
		if stop[start_i] != 0:
			remaining -= 1
		if remaining <= 0:
			return dist
	var head := 0
	var tail := 1
	while head < tail:
		var i := queue[head]
		head += 1
		if dist[i] >= limit:
			break  # queue is in distance order: nothing left to expand
		var x := i % w
		var di := dist[i] + 1
		var ni := i + 1
		if x + 1 < w and t[ni] == FLOOR and dist[ni] < 0 and blk[ni] == 0:
			dist[ni] = di
			queue[tail] = ni
			tail += 1
			if has_stop and stop[ni] != 0:
				remaining -= 1
				if remaining == 0 or not stop_all:
					limit = mini(limit, di + slack)
		ni = i - 1
		if x > 0 and t[ni] == FLOOR and dist[ni] < 0 and blk[ni] == 0:
			dist[ni] = di
			queue[tail] = ni
			tail += 1
			if has_stop and stop[ni] != 0:
				remaining -= 1
				if remaining == 0 or not stop_all:
					limit = mini(limit, di + slack)
		ni = i + w
		if ni < n and t[ni] == FLOOR and dist[ni] < 0 and blk[ni] == 0:
			dist[ni] = di
			queue[tail] = ni
			tail += 1
			if has_stop and stop[ni] != 0:
				remaining -= 1
				if remaining == 0 or not stop_all:
					limit = mini(limit, di + slack)
		ni = i - w
		if ni >= 0 and t[ni] == FLOOR and dist[ni] < 0 and blk[ni] == 0:
			dist[ni] = di
			queue[tail] = ni
			tail += 1
			if has_stop and stop[ni] != 0:
				remaining -= 1
				if remaining == 0 or not stop_all:
					limit = mini(limit, di + slack)
	return dist


func _carve(x: int, y: int) -> void:
	tiles[y * width + x] = FLOOR


## o: game.json "level" block {width, height, roomAttempts, minRooms, maxRooms, minRoomSize, maxRoomSize}.
static func generate(rng: RefCounted, o: Dictionary) -> RefCounted:
	var l: RefCounted = (load("res://core/level.gd") as GDScript).new()
	l.width = int(o.width)
	l.height = int(o.height)
	l.tiles = PackedByteArray()
	l.tiles.resize(l.width * l.height)
	l.tiles.fill(WALL)
	var rooms: Array = []
	var i := 0
	while i < int(o.roomAttempts) and rooms.size() < int(o.maxRooms):
		i += 1
		var w: int = rng.int_range(int(o.minRoomSize), int(o.maxRoomSize))
		var h: int = rng.int_range(int(o.minRoomSize), int(o.maxRoomSize))
		var rx: int = rng.int_range(1, l.width - w - 2)
		var ry: int = rng.int_range(1, l.height - h - 2)
		var r := {"x": rx, "y": ry, "w": w, "h": h}
		var clash := false
		for other in rooms:
			if _overlaps(r, other, 1):
				clash = true
				break
		if not clash:
			rooms.append(r)
	assert(rooms.size() >= int(o.minRooms), "Level generator placed %d rooms, needs %d; map too small?" % [rooms.size(), int(o.minRooms)])
	for r in rooms:
		for y in range(r.y, r.y + r.h):
			for x in range(r.x, r.x + r.w):
				l._carve(x, y)

	# Connect rooms in left-to-right order with L-shaped corridors, plus one extra loop.
	# Array.sort_custom is not stable; JS sort is, so use a stable insertion sort.
	var order: Array = rooms.duplicate()
	for a in range(1, order.size()):
		var cur: Dictionary = order[a]
		var b := a - 1
		while b >= 0 and room_center(order[b]).x > room_center(cur).x:
			order[b + 1] = order[b]
			b -= 1
		order[b + 1] = cur
	for k in range(1, order.size()):
		l._corridor(rng, room_center(order[k - 1]), room_center(order[k]))
	if order.size() > 3:
		l._corridor(rng, room_center(order[0]), room_center(order[int(order.size() / 2) + 1]))

	l.rooms = order
	l.start = room_center(order[0])
	# Stairs go in the room farthest (by walking distance) from the start.
	var dist: PackedInt32Array = l.distance_map(l.start)
	var best: Dictionary = order[order.size() - 1]
	var best_d := -1
	for r in order:
		var c := room_center(r)
		var d := dist[c.y * l.width + c.x]
		if d > best_d:
			best_d = d
			best = r
	l.stairs = room_center(best)
	return l


func _corridor(rng: RefCounted, a: Vector2i, b: Vector2i) -> void:
	var horizontal_first: bool = rng.chance(0.5)
	var corner := Vector2i(b.x, a.y) if horizontal_first else Vector2i(a.x, b.y)
	for pq in [[a, corner], [corner, b]]:
		var p: Vector2i = pq[0]
		var q: Vector2i = pq[1]
		for x in range(mini(p.x, q.x), maxi(p.x, q.x) + 1):
			_carve(x, p.y)
		for y in range(mini(p.y, q.y), maxi(p.y, q.y) + 1):
			_carve(q.x, y)
