# Game Creator Studio

An AI-directed studio that turns a game pitch into a playable game. Claude directs; GPT, Meshy, ElevenLabs and Blender are tools it calls. Full plan: [docs/design-doc.md](docs/design-doc.md).

This repo currently holds the **first end-to-end test** from the design doc: a roguelike dungeon crawler built from encyclopedia modules, a Three.js preview, the automated checks, and the concept-art → Meshy → Blender asset pipeline.

## Quick start

```bash
npm install
npm run dev          # play the preview at http://localhost:5173 (?seed=anything)
npm run check        # typecheck + unit tests + balance sim + bot playtest
npm run qa:visual    # headless Chromium: bot plays, screenshots saved to qa-output/
```

## Layout

| Path | What it is |
| --- | --- |
| `projects/dungeon-crawler/` | One project folder = source of truth: bible, game description, assets |
| `projects/*/bible/*.json` | Element bible, one file per layer (meta, visual, audio, lore, code) |
| `projects/*/game.json` | Engine-neutral game description (modules, levels, entities, controls, QA targets) |
| `projects/*/assets.json` | Asset registry: status, source, lock, bible version, spend (created on first asset) |
| `encyclopedia/` | Index plus one entry per reusable module, following the doc's entry template |
| `src/core/` | Engine-neutral modules: seeder, level design, D&D combat, loot roller, inventory, game loop |
| `src/engines/three/` | Three.js renderer and UI/HUD kit |
| `src/pipeline/` | Concept → Meshy → Blender pipeline, approval gates, asset registry |
| `src/qa/` | Bot playtester, reachability checks, balance simulation |
| `tools/blender/cleanup.py` | Headless Blender cleanup: scale, pivot, decimate, palette snap, LODs, GLB |
| `studio/services.json` | API endpoints, model names and price estimates in one place |

## Asset pipeline: GPT concept art → Meshy → Blender

The approved GPT concept image is the exact picture Meshy turns into a model.

```bash
export OPENAI_API_KEY=... MESHY_API_KEY=...
export BLENDER=/path/to/blender        # or a python that has `pip install bpy`

npm run asset -- concept "crypt rat" --kind creature   # shows a cost estimate, stops
npm run asset -- concept "crypt rat" --kind creature --yes
# look at projects/dungeon-crawler/assets/concepts/crypt-rat.png
npm run asset -- approve crypt-rat     # locks the look; becomes a style reference for later concepts
npm run asset -- to3d crypt-rat --yes  # Meshy image-to-3D from that PNG, poly budget from the bible
npm run asset -- cleanup crypt-rat     # Blender → assets/models/crypt-rat.glb (+ .lod1/.lod2)
npm run asset -- list                  # asset browser: status, source, lock, bible version, spend
```

Add `--dry-run` to any command to run the whole chain with placeholders and no API spend. To use a model in the game, set `"model": "assets/models/crypt-rat.glb"` on the enemy in `bible/lore.json`; the preview swaps the primitive for the GLB.

- Asset concepts use the Meshy-friendly template (single centred object, plain background, A-pose for characters, even lighting) plus the bible's palette and style; mood art uses a separate template.
- Approved concepts are sent as style references (OpenAI image edits endpoint) so later concepts stay on-style.
- Asking for a subject that already exists hits the cache instead of paying again.

### Audio (ElevenLabs), imports, bible versions, asset QA

```bash
export ELEVENLABS_API_KEY=...
npm run asset -- sfx "bone clatter" --duration 1.5 --yes     # prompt uses bible audio.sfxStyle
npm run asset -- music combat --seconds 60 --yes             # mood from bible audio.musicMoods; loop points stored
npm run asset -- voice warden "Turn back, little candle." --yes   # fixed voice from audio.voices.warden.voiceId
npm run asset -- voices lines.json --yes                     # [{characterId, text}]: ONE gate for the whole batch

npm run asset -- import boss.ogg --origin purchased-pack --license "Crypt Pack, 1 commercial game" --tag "boss battle"
npm run asset -- import goblin.fbx --origin commissioned --license "work for hire" --kind character
npm run asset -- import sketch.png --origin in-house --license "ours" --as reference   # -> bible visual.concepts

npm run asset -- bump-bible        # after a bible change (e.g. palette)
npm run asset -- stale             # non-locked assets built against an older bible
npm run asset -- rematerial <id>   # free: re-run Blender cleanup/palette snap on the raw model
npm run asset -- regenerate <id>   # paid, gated: new concept + Meshy (or the same ElevenLabs request)
npm run asset -- qa-assets         # floating / wrong scale / over poly budget / off-palette GLBs; OGG checks
```

- Every audio file (generated or imported) is loudness-normalized with ffmpeg `loudnorm` (music/voice -16 LUFS, SFX -14) and converted to OGG Vorbis; music gets `loopStart`/`loopEnd` (default: whole track). Needs `ffmpeg`/`ffprobe` on the PATH (or `FFMPEG`/`FFPROBE`).
- Imports need `--origin purchased-pack|commissioned|royalty-free|in-house` and `--license "..."`, are tagged (`--tag`, repeatable), and are **locked** (`source: "imported"`): the agent never regenerates or re-materials them. Type comes from the extension (`--as` to override; audio ≥ 30 s counts as music). Models (glb/gltf/fbx/obj) go through the same Blender cleanup as Meshy output; images are resized to the bible's `textureResolution` with a 256 px thumbnail and 64 px icon; fonts (ttf/otf) are copied and registered.
- `--dry-run` uses sine tones instead of ElevenLabs, so the ffmpeg step still runs for real. Asset QA also runs as part of `npm run qa`.

## Status

Working and tested: seeder sub-streams, level generation, combat, loot, inventory, game loop, HUD, Three.js preview (desktop + touch), bible validation, bot playtests, balance sims, visual check, pipeline gates/registry/cache, Blender cleanup (tested with Blender 5.2's bpy module; glb/gltf/fbx/obj input), ElevenLabs audio pipeline (mocked API, real ffmpeg processing), external imports, bible versioning (stale/rematerial/regenerate), asset QA.

Not yet done:
- **Live API calls** to OpenAI, Meshy and ElevenLabs are written against their documented request shapes and covered by mocked tests, but have not been run with real keys. Check `studio/services.json` (model names, prices) before the first real run.
- Godot output, GBA-style animation, the chat-plus-preview studio UI, and the Claude Code tool wiring (MCP).

Decision taken: bible files are JSON (open question in the doc). Still open: bring-your-own keys vs hosted, desktop vs web.
