# Seeder: deterministic random numbers with named sub-streams.
# Bit-for-bit port of src/core/seeder.ts. GDScript ints are signed 64-bit, so
# every 32-bit value is kept unsigned in [0, 2^32) and masked after each
# operation; imul splits the multiply so the product never leaves 64 bits.
# Parity with the TypeScript version is asserted by tests/godot.test.ts.
extends RefCounted

const M32 := 0xFFFFFFFF

var seed: String
var _a: int
var _b: int
var _c: int
var _d: int


## Math.imul(a, b) >>> 0 for unsigned 32-bit inputs.
static func imul(a: int, b: int) -> int:
	var lo := (a & 0xFFFF) * b
	var hi := (((a >> 16) * b) & 0xFFFF) << 16
	return (lo + hi) & M32


## UTF-16 code units, like String.prototype.charCodeAt.
static func utf16_units(s: String) -> PackedInt32Array:
	var out := PackedInt32Array()
	for i in s.length():
		var cp := s.unicode_at(i)
		if cp > 0xFFFF:
			cp -= 0x10000
			out.append(0xD800 + (cp >> 10))
			out.append(0xDC00 + (cp & 0x3FF))
		else:
			out.append(cp)
	return out


static func hash_string(s: String) -> int:
	var h := 0x811c9dc5
	for unit in utf16_units(s):
		h ^= unit
		h = imul(h, 0x01000193)
	h ^= h >> 16
	h = imul(h, 0x85ebca6b)
	h ^= h >> 13
	h = imul(h, 0xc2b2ae35)
	h ^= h >> 16
	return h & M32


func _init(p_seed: String) -> void:
	seed = p_seed
	_a = hash_string(p_seed + "#a")
	_b = hash_string(p_seed + "#b")
	_c = hash_string(p_seed + "#c")
	_d = hash_string(p_seed + "#d")
	for i in 12:
		next_uint()


## sfc32
func next_uint() -> int:
	var t := (((_a + _b) & M32) + _d) & M32
	_d = (_d + 1) & M32
	_a = _b ^ (_b >> 9)
	_b = (_c + ((_c << 3) & M32)) & M32
	_c = ((_c << 21) & M32) | (_c >> 11)
	_c = (_c + t) & M32
	return t


## Float in [0, 1).
func next() -> float:
	return float(next_uint()) / 4294967296.0


## Integer in [lo, hi], inclusive.
func int_range(lo: int, hi: int) -> int:
	return lo + int(floor(next() * float(hi - lo + 1)))


func chance(p: float) -> bool:
	return next() < p


func pick(items: Array) -> Variant:
	assert(not items.is_empty(), "Rng.pick on empty list")
	return items[int(floor(next() * float(items.size())))]


## Picks by weight (entries are Dictionaries with a "weight" key). Weight <= 0 never wins.
func weighted(entries: Array) -> Variant:
	var total := 0.0
	for e in entries:
		total += maxf(0.0, float(e["weight"]))
	assert(total > 0.0, "Rng.weighted with no positive weights")
	var r := next() * total
	for e in entries:
		r -= maxf(0.0, float(e["weight"]))
		if r < 0.0:
			return e
	return entries[entries.size() - 1]


## A new independent stream derived from this one's seed and a name.
func fork(name: String) -> RefCounted:
	return (get_script() as GDScript).new("%s/%s" % [seed, name])


# --- dice -------------------------------------------------------------------

static var _flat_re: RegEx
static var _dice_re: RegEx


static func parse_dice(expr: String) -> Dictionary:
	if _flat_re == null:
		_flat_re = RegEx.create_from_string("^\\s*(-?\\d+)\\s*$")
		_dice_re = RegEx.create_from_string("(?i)^\\s*(\\d*)d(\\d+)\\s*(?:([+-])\\s*(\\d+))?\\s*$")
	var flat := _flat_re.search(expr)
	if flat:
		return {"count": 0, "sides": 0, "modifier": int(flat.get_string(1))}
	var m := _dice_re.search(expr)
	assert(m != null, "Bad dice expression: \"%s\"" % expr)
	var count := int(m.get_string(1)) if m.get_string(1) != "" else 1
	var sides := int(m.get_string(2))
	var modifier := 0
	if m.get_string(4) != "":
		modifier = int(m.get_string(4)) * (-1 if m.get_string(3) == "-" else 1)
	assert(sides >= 1 and count >= 0, "Bad dice expression: \"%s\"" % expr)
	return {"count": count, "sides": sides, "modifier": modifier}


## Rolls "2d6+1"-style dice. extra_dice adds dice (used for critical hits).
static func roll_dice(rng: RefCounted, expr: String, extra_dice: int = 0) -> Dictionary:
	var p := parse_dice(expr)
	var rolls: Array[int] = []
	var n: int = p.count + (extra_dice if p.count > 0 else 0)
	var total := 0
	for i in n:
		var r: int = rng.int_range(1, p.sides)
		rolls.append(r)
		total += r
	return {"total": total + p.modifier, "rolls": rolls, "modifier": p.modifier}


static func average_dice(expr: String) -> float:
	var p := parse_dice(expr)
	return float(p.count * (p.sides + 1)) / 2.0 + p.modifier
