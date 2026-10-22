# Game Creator Studio

An AI-directed studio that turns a game pitch into a playable 3D game. Claude is the director; GPT (concept art), Meshy (3D), ElevenLabs (audio) and Blender (cleanup) are tools it calls. Every game is one project folder holding a per-project **element bible**, built from a studio-wide **encyclopedia** of reusable modules, and it runs in both **Three.js** (instant browser preview, shareable build) and **Godot** (full engine project). Spec: [docs/design-doc.md](docs/design-doc.md).

## Quick start

```bash
npm install
npm run studio                       # the studio app: http://localhost:4400
npm run studio -- --dry-run-tools    # same, but paid tools make placeholders and cost $0
npm run dev                          # just the game preview (?project=<name>&seed=<seed>)
npm run check                        # typecheck + all tests + balance sim + bot playtest
```

The studio needs the `claude` CLI installed and logged in (it runs Claude Code headless as the director). For real assets set `OPENAI_API_KEY`, `MESHY_API_KEY`, `ELEVENLABS_API_KEY`; for model cleanup set `BLENDER` (a Blender binary, or a Python with `pip install bpy`); `ffmpeg` must be on the PATH; for Godot exports and playtests set `GODOT` (Godot 4.5+).

## The studio

A chat-plus-preview app. The director chat sits on the left (on a phone it's the **Chat** tab); the right side has:

| Tab | What it does |
| --- | --- |
| **Play** | The game running live in Three.js. Bible edits reload it. "Open in new tab" gives the shareable page. |
| **Bible** | Edit every layer with forms (palette colour pickers, stat blocks, loot tables, voices…) or raw JSON. Saves are validated and bump the bible version. **Approve bible** unlocks Meshy and ElevenLabs spend. |
| **Assets** | The asset browser: status (concept → approved → 3D → cleaned), source, license, lock, bible version (stale badge), spend, a 3D viewer and an audio player. Approve a concept's look, make 3D, re-material, import files, generate audio, and use a model for any player/enemy/item. |
| **Tasks** | What the director is doing now, its plan, everything waiting on you, and background jobs with logs. |
| **Costs** | Spend per service (Anthropic, OpenAI, Meshy, ElevenLabs) and a ledger. |
| **QA** | Bot playtest + balance, headless-browser visual check with screenshots, asset QA, Godot export and Godot playtest, or "ask the director to review". |
| **History** | Checkpoints (git commits of the project folder), restore any earlier version, and "try a variant" branches. |

**New game** → pick a starter bible (dark fantasy, low-poly cozy, retro sci-fi) and type a pitch. The director drafts the bible, requests a few cheap concept images, runs QA and checkpoints; you review and approve the bible before any 3D or audio spend.

**Approval gates.** The director can *request* paid work but never approve it: each request shows up in **Approvals** with a cost estimate, and runs only after you approve it (the director is told automatically). Clicking a paid button yourself shows the same estimate first.

### How the director works

Each chat message runs one `claude -p` turn inside the project folder (resuming the project's session), with the studio's MCP tools (`src/studio/mcp.ts`): `read_bible`/`write_bible`, `encyclopedia_index`/`encyclopedia_entry`, `generate_concept`, `generate_mood_art`, `make_3d`, `cleanup_model`, `set_entity_model`, `generate_sfx`, `generate_music`, `voice_lines`, `stale_assets`, `rematerial`, `regenerate`, `check_assets`, `run_qa`, `visual_check`, `export_godot`, `godot_qa`, `update_task_board`, `checkpoint`, `studio_status`. It can also edit code in the repo (the engine-neutral core and engines) with Claude Code's own tools. You can use the same tools from a terminal Claude Code session: `.mcp.json` points them at `projects/dungeon-crawler` (change `STUDIO_PROJECT_DIR` for another project).

Anthropic spend per turn comes from Claude Code's own cost report. Check Anthropic's terms on which Claude Code auth methods a third-party app may use before shipping this to other people.

## Layout

| Path | What it is |
| --- | --- |
| `projects/<name>/` | One game = one folder: `bible/` (one JSON per layer), `game.json` (engine-neutral description), `assets/`, `assets.json` (registry), `approvals.json`, `costs.json` |
| `studio/starters/` | Starter bibles: dark-fantasy, low-poly-cozy, retro-sci-fi |
| `studio/services.json` | API endpoints, model names and price estimates in one place |
| `encyclopedia/` | Index plus one entry per reusable module (the doc's entry template) |
| `src/core/` | Engine-neutral modules: seeder, level design, D&D combat, loot roller, inventory, game loop, shared contracts |
| `src/engines/three/` | Three.js renderer, UI/HUD kit, GBA-style animation, event-driven audio |
| `engines/godot/dungeon-crawler/` | Godot 4.5 genre template: GDScript port of the core, scenes, HUD, saves, headless QA |
| `src/pipeline/` | Concept → Meshy → Blender, ElevenLabs audio, imports, bible versioning, approval gates, registry |
| `src/studio/` | Studio server, director (Claude Code runner), MCP tools, approvals, ledger, git, task board, UI |
| `src/qa/` | Bot playtester, balance sims, asset QA, Godot parity dumps |
| `tools/blender/cleanup.py` | Headless Blender cleanup: scale, pivot, decimate, palette snap, LODs, GLB |

`projects/frost-mine` ("Lanternfall") was made end to end in the studio from a one-line pitch, with paid tools in dry-run mode, so its concept art, model and audio are placeholders.

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

## Godot

`engines/godot/dungeon-crawler/` is the Godot 4.5 genre template (GDScript, Compatibility renderer). Its `core/` is a port of `src/core/` (seeder, level design, combat, loot, inventory, turn loop) that reads the project's bible layers and `game.json` from `res://data/` at runtime. The scene draws the same top-down view as the Three.js preview: MultiMesh floor and walls, one `entity.tscn` per entity (primitive or the bible's GLB), palette materials and the HUD. Input actions come from the bible's `code.godot.controls`. Saves follow `code.godot.saves`: F5 writes seed, floor, turn and inventory to `user://save.json`, F9 loads it and the floor is regenerated from the seed. Saves also happen on every new floor.

```bash
export GODOT=/path/to/Godot_v4.5.1-stable_linux.x86_64
npx tsx scripts/export-godot.ts --project projects/dungeon-crawler      # -> build/godot/dungeon-crawler
$GODOT --path build/godot/dungeon-crawler                               # play (-- --seed foo, -- --continue)
npx tsx scripts/godot-qa.ts                                             # 200 bot runs in Godot, compared with TS
npx vitest run tests/godot.test.ts                                      # parity: rng, levels, spawns, bot play
```

- **No second hand-synced codebase.** `qa/parity.gd` and `src/qa/parity.ts` dump the same data: raw rng streams, dice and loot rolls, levels for floors 1-3, spawns, and the state, messages and events after the bot plays. `tests/godot.test.ts` requires them to be equal, and `godot-qa.ts` requires every Godot playtest run to match the TS run with the same seed. Change a rule in `src/core/` and the test shows where the port needs the same change.
- **Headless playtest.** `$GODOT --headless --path <proj> --script res://qa/playtest.gd -- --runs N` prints `PLAYTEST_JSON {...}` with the win rate, deaths by floor, crashes, softlocks and unreachable areas. Script errors count as crashes because GDScript has no exceptions; they are caught with Godot 4.5's `Logger`.
- **Screenshots.** Headless Godot cannot render. `godot-qa.ts --screenshot` runs `qa/screenshot.gd` under `xvfb-run` (Mesa llvmpipe, OpenGL) and saves `qa-output/godot-visual-1.png`.
- **Models.** The exporter copies every GLB the bible (`model` on the player, enemies or items) or `assets.json` (cleaned / in-game) points at, LODs included, to the same `res://` path. A project that has not been imported parses GLBs at runtime with `GLTFDocument`. `--import` runs `godot --import` so they load as native resources.
- **Builds.** `--export web|linux` imports the project and uses the presets in `export_presets.cfg`. This needs Godot export templates in `~/.local/share/godot/export_templates/<version>/`. Without them the exporter says so and skips the build.
- GDScript runs the bot about 7x slower than Node (about 40 s for 200 runs, against 5 s in TS). The bot's searches stop early once their goal is found. This changes no results; the parity test checks that.


## Quality control

- `npm run qa -- --project projects/<name>`: bible validation, balance simulation (thousands of seeded duels and loot rolls), 200 bot playtests flagging crashes, softlocks and unreachable areas, and asset QA.
- `npm run qa:visual -- --project <name>`: builds the preview, plays it in headless Chromium at desktop and phone sizes, fails on console errors or draw-call/triangle budgets, and saves screenshots for the director (or you) to review against the bible.
- `npm run qa:godot -- --project projects/<name>`: the same bot playtest inside Godot, compared run-by-run with the TypeScript core.

## Status

Built and tested (84 tests with Blender and Godot available; tests that need them skip otherwise): everything above, including a live end-to-end run of the studio with the real Claude director.

Not verified yet:
- **Live API calls** to OpenAI, Meshy and ElevenLabs. They're written against the documented request shapes and covered by mocked tests, but not run with real keys. Check `studio/services.json` (model names, endpoints, prices) before the first real run.
- **Godot builds** (`--export web|linux`) need Godot export templates installed; the exported project itself is tested.

Decisions taken: bible files are JSON. Still open from the design doc: bring-your-own keys vs hosted billing, desktop app vs web tool (today it's a local web app; the Three.js build in `dist/` is a static shareable game).
