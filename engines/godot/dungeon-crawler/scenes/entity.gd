# One scene per entity (bible code.godot.entityStructure): CharacterBody3D
# root, a MeshInstance3D (primitive, or the GLB from the bible's `model` path)
# under Body, and an Area3D for interaction. Game logic stays in the core; this
# node only shows an entity and eases toward its grid position.
extends CharacterBody3D

var uid := ""
var kind := ""  # player | enemy | item
var def_id := ""
var target := Vector3.ZERO
var bob := false

@onready var body: Node3D = $Body
@onready var area: Area3D = $Area


## stats: the bible entry (lore.player, a bestiary entry or an item).
## model: an instantiated GLB scene, or null for the primitive fallback.
func setup(p_uid: String, p_kind: String, p_def_id: String, mat: Material, model: Node3D) -> void:
	uid = p_uid
	kind = p_kind
	def_id = p_def_id
	name = "%s_%s" % [kind, uid.replace(":", "_")]
	bob = kind == "item"
	for c in body.get_children():
		c.queue_free()
	if model:
		body.add_child(model)
		return
	var mi := MeshInstance3D.new()
	mi.name = "Mesh"
	match kind:
		"player":
			var cap := CapsuleMesh.new()
			cap.radius = 0.28
			cap.height = 1.16
			mi.mesh = cap
			mi.position.y = 0.58
		"item":
			# Octahedron: a 4-sided, 2-ring sphere.
			var oct := SphereMesh.new()
			oct.radius = 0.2
			oct.height = 0.4
			oct.radial_segments = 4
			oct.rings = 1
			mi.mesh = oct
			mi.position.y = 0.35
		_:
			var size := 0.35 if def_id == "rat" else (0.55 if def_id == "slime" else 0.75)
			if def_id == "slime":
				var s := SphereMesh.new()
				s.radius = size / 2.0
				s.height = size
				s.radial_segments = 10
				s.rings = 6
				mi.mesh = s
				mi.position.y = size / 2.4
			else:
				var cone := CylinderMesh.new()
				cone.top_radius = 0.0
				cone.bottom_radius = size / 2.4
				cone.height = size * 1.3
				cone.radial_segments = 6
				mi.mesh = cone
				mi.position.y = size * 0.65
	mi.material_override = mat
	mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON
	body.add_child(mi)


func place(grid: Vector2i, snap: bool) -> void:
	target = Vector3(grid.x, 0, grid.y)
	if snap:
		position = target


func _process(delta: float) -> void:
	var k := 1.0 - pow(0.0001, delta)
	position.x += (target.x - position.x) * k
	position.z += (target.z - position.z) * k
	if bob:
		var t := Time.get_ticks_msec() / 1000.0
		body.rotation.y = t * 1.5
		body.position.y = sin(t * 2.0 + target.x) * 0.05
