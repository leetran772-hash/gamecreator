# D&D-style combat: d20 + attack bonus vs armor class. A natural 20 always hits
# and doubles the damage dice; a natural 1 always misses.
# Port of src/core/combat.ts. Combatants are anything with ac, attack_bonus and
# damage fields (Actor objects or Dictionaries).
extends RefCounted

const Seeder := preload("res://core/seeder.gd")


static func resolve_attack(rng: RefCounted, attacker, defender) -> Dictionary:
	var roll: int = rng.int_range(1, 20)
	var total: int = roll + int(attacker.attack_bonus)
	var crit := roll == 20
	var hit := crit or (roll != 1 and total >= int(defender.ac))
	var damage := 0
	if hit:
		var count: int = Seeder.parse_dice(attacker.damage).count
		damage = maxi(1, Seeder.roll_dice(rng, attacker.damage, count if crit else 0).total)
	return {"roll": roll, "total": total, "targetAc": int(defender.ac), "hit": hit, "crit": crit, "damage": damage}


## Chance that `attacker` hits `defender` on one swing.
static func hit_chance(attacker, defender) -> float:
	var hits := 0
	for roll in range(1, 21):
		if roll == 20 or (roll != 1 and roll + int(attacker.attack_bonus) >= int(defender.ac)):
			hits += 1
	return hits / 20.0
