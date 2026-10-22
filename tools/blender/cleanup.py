"""Headless Blender cleanup for generated (Meshy) and imported 3D models.

Usage:
  blender -b --factory-startup -P cleanup.py -- in.glb out.glb '{"targetHeight":1.8,...}'
  (input may be .glb, .gltf, .fbx or .obj; output is always GLB)
  python cleanup.py -- in.glb out.glb '{...}'          (with the bpy module installed)

Steps: join meshes, normalize scale to targetHeight, pivot at bottom centre,
decimate to maxTriangles, snap untextured materials to the bible palette,
write LOD files (<out>.lod1.glb, ...), export GLB. Prints one line:
  CLEANUP_RESULT {"triangles": ..., "lods": [...], "height": ...}
"""
import json
import os
import sys

import bpy
from mathutils import Vector


def args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    if len(argv) < 3:
        raise SystemExit("usage: cleanup.py -- in.glb out.glb settings_json")
    return argv[0], argv[1], json.loads(argv[2])


def hex_to_linear(h):
    h = h.lstrip("#")
    srgb = [int(h[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    return [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]


def mesh_objects():
    return [o for o in bpy.context.scene.objects if o.type == "MESH"]


def triangle_count(objs):
    total = 0
    for o in objs:
        for p in o.data.polygons:
            total += len(p.vertices) - 2
    return total


def world_bounds(objs):
    lo = Vector((float("inf"),) * 3)
    hi = Vector((float("-inf"),) * 3)
    for o in objs:
        for corner in o.bound_box:
            w = o.matrix_world @ Vector(corner)
            lo = Vector(min(a, b) for a, b in zip(lo, w))
            hi = Vector(max(a, b) for a, b in zip(hi, w))
    return lo, hi


def select_only(objs, active=None):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active or (objs[0] if objs else None)


def apply_decimate(obj, ratio):
    if ratio >= 0.999:
        return
    mod = obj.modifiers.new("decimate", "DECIMATE")
    mod.ratio = max(0.01, ratio)
    mod.use_collapse_triangulate = True
    select_only([obj])
    bpy.ops.object.modifier_apply(modifier=mod.name)


def snap_materials(objs, palette):
    colors = {name: hex_to_linear(h) for name, h in palette.items()}
    snapped = {}
    for o in objs:
        for slot in o.material_slots:
            mat = slot.material
            if not mat or not mat.use_nodes:
                continue
            bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
            if not bsdf:
                continue
            base = bsdf.inputs["Base Color"]
            if base.is_linked:  # textured: keep Meshy's texture
                continue
            c = list(base.default_value)[:3]
            name, best = min(colors.items(), key=lambda kv: sum((a - b) ** 2 for a, b in zip(kv[1], c)))
            base.default_value = (*best, 1.0)
            snapped[mat.name] = name
    return snapped


def import_model(path):
    """GLB/glTF (Meshy output and imports), FBX and OBJ (imports)."""
    ext = os.path.splitext(path)[1].lower()
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == ".obj":
        if hasattr(bpy.ops.wm, "obj_import"):  # Blender 3.2+
            bpy.ops.wm.obj_import(filepath=path)
        else:
            bpy.ops.import_scene.obj(filepath=path)
    else:
        raise SystemExit("unsupported model format: " + ext)


def export(path, objs):
    select_only(objs)
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_apply=True)


def main():
    src, out, s = args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    import_model(os.path.abspath(src))

    objs = mesh_objects()
    if not objs:
        raise SystemExit("no meshes in " + src)
    rigged = any(o.type == "ARMATURE" for o in bpy.context.scene.objects)

    # Bake parent transforms into the meshes and join them (rigged models stay as-is).
    if not rigged:
        select_only(objs)
        bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        if len(objs) > 1:
            bpy.ops.object.join()
        for o in list(bpy.context.scene.objects):
            if o.type != "MESH":
                bpy.data.objects.remove(o, do_unlink=True)
        objs = mesh_objects()

    # Normalize scale so the model is targetHeight tall (Blender is Z-up; glTF export converts to Y-up).
    lo, hi = world_bounds(objs)
    height = max(hi.z - lo.z, 1e-6)
    factor = float(s.get("targetHeight", 1.0)) / height
    roots = [o for o in bpy.context.scene.objects if o.parent is None]
    for r in roots:
        r.scale = r.scale * factor
        r.location = r.location * factor
    bpy.context.view_layer.update()

    # Pivot at bottom centre.
    lo, hi = world_bounds(objs)
    offset = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    for r in roots:
        r.location = r.location - offset
    bpy.context.view_layer.update()
    if not rigged:
        select_only(objs)
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    # Decimate to the bible's poly budget.
    max_tris = int(s.get("maxTriangles", 10000))
    for o in objs:
        tris = triangle_count([o])
        if tris > max_tris:
            apply_decimate(o, max_tris / tris)

    snapped = snap_materials(objs, s.get("palette", {})) if s.get("palette") else {}

    os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
    export(out, [o for o in bpy.context.scene.objects])
    lods = [triangle_count(objs)]

    # LODs as sibling files: name.lod1.glb, name.lod2.glb ...
    base = out[:-4] if out.lower().endswith(".glb") else out
    prev = 1.0
    for i, ratio in enumerate(s.get("lodRatios", [1])[1:], start=1):
        for o in objs:
            apply_decimate(o, ratio / prev)
        prev = ratio
        export(f"{base}.lod{i}.glb", [o for o in bpy.context.scene.objects])
        lods.append(triangle_count(objs))

    lo, hi = world_bounds(objs)
    print("CLEANUP_RESULT " + json.dumps({"triangles": lods[0], "lods": lods, "height": round(hi.z - lo.z, 4), "snapped": snapped}))


main()
