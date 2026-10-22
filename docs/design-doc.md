# 3D Game Creator Studio — Design Doc

Oct 21, 2026 · @Lee. Markdown copy of the original PDF; this is the source of truth for scope.

## Overview and core flow

An AI-directed studio that turns a game pitch into a playable Godot or Three.js game. Claude directs the work and calls specialist tools; a per-project element bible keeps every output on-style, and a studio-wide encyclopedia supplies reusable systems.

1. Pitch from the user
2. Element bible drafted, then edited and approved by the user
3. Asset list derived from the bible and chosen encyclopedia entries
4. Concepts (GPT) → 3D (Meshy) → cleanup (Blender); audio (ElevenLabs); external imports processed
5. Engine-neutral game description (entities, behaviors, levels as data)
6. Engine code generated for Godot and/or Three.js
7. Automated playtest and visual checks, then preview
8. Iterate

Out of scope for this version: shipping (exports, localization, accessibility kit) and studio-level features (cross-project licensing reports, multi-user collaboration).

## Tool roster and roles

Claude is the director; every other service is a tool it calls. Claude Code is the studio's built-in terminal: it runs inside each project folder with its own agent loop, file editing and shell access, and the other services are exposed to it as tools (MCP servers or CLI scripts). The only external APIs are OpenAI, ElevenLabs and Meshy; Blender, Godot and Three.js run locally.

| Tool | Role | Notes |
| --- | --- | --- |
| Claude Code (embedded) | Director: design, planning, game code, Blender scripts, reviews | Runs as the studio's terminal pane. Reads the bible and encyclopedia index when planning |
| GPT image generation | 2D concepts: mood boards, key art, character sheets, Meshy input images | Separate prompt templates for mood art vs. asset concepts |
| Meshy | Image-to-3D (preferred over text-to-3D), texturing, basic rigging | Output always goes through Blender cleanup |
| ElevenLabs | Music; also character voices and SFX | One fixed voice ID per character, stored in the bible |
| Blender (headless, bpy) | Cleanup and glue: scale, pivots, decimation, materials, LODs, GLB export | Runs as a separate background process |

Credentials required: Claude Code authentication, plus OpenAI, ElevenLabs and Meshy keys. Check Anthropic's terms on which Claude Code auth methods a third-party app may use. Open decision: users bring their own keys, or the studio hosts and charges.

## Engines: Godot + Three.js

Three.js handles instant in-browser previews and shareable links; Godot handles full builds. Both read GLB natively, so the pipeline produces one asset format.

- **Engine-neutral game description:** entities, behaviors, controls and level layouts stored as data. Claude generates Godot or Three.js code from it, so there are never two hand-synced codebases.
- **Genre templates per engine:** starting from a template (platformer, top-down, FPS, dungeon crawler) instead of a blank project raises generated-code quality.
- **Code conventions** for each engine (entity structure, controls, saves) live in the bible's code layer and in encyclopedia entries.

## Element bible (per project)

Each game has its own bible, stored as structured files (YAML or JSON plus an image folder) so each pipeline step pulls only the slice it needs.

| Layer | Contents | Consumed by |
| --- | --- | --- |
| Visual | Palette, material presets, poly budgets, texture resolution, approved concepts, user-uploaded references | GPT (style references), Meshy prompts, Blender enforcement |
| Audio | Voice ID per character, SFX style notes, music moods | ElevenLabs, import tagging |
| Lore and design | Characters, factions, rules, tone, stat blocks, loot tables | Claude for dialogue, quests, mechanics |
| Code conventions | Entity, controls and save structure per engine | Claude code generation |

- **Creation is the onboarding step.** Pitch → Claude drafts the bible with a few cheap concept images and a cast with voices → the user edits and approves before any Meshy or ElevenLabs spend.
- **Starter bibles.** Genre and style presets (low-poly cozy, dark fantasy, retro sci-fi) so nobody starts from a blank page.
- **Versioning.** Every asset is tagged with the bible version it was built against. When the bible changes (e.g. palette), the studio lists affected assets and offers to regenerate or re-material only those.
- **Project folder = source of truth.** Bible, assets, game description and engine outputs in one Git-backed folder, giving undo and branching for free.

## Encyclopedia of capabilities

The bible says what a game is; the encyclopedia says what the studio knows how to build. Claude reads the encyclopedia index while planning, picks entries that fit the pitch, and fills them from the project's bible.

### Entry template

Each entry is an executable module, not just a description:

- **What it is:** one paragraph, plus genres it suits
- **Bible inputs:** what it reads from the project (e.g. combat reads stat blocks, classes, damage types)
- **Outputs:** code, data files and assets it produces
- **Implementations:** Godot, Three.js, or a note that one is missing
- **Dependencies:** hard (cannot run without) vs. event-based (listens for another module's events)
- **Status:** prototype, stable or battle-tested
- **Known gotchas:** what broke last time

### Current entries

| Entry | Category | Depends on |
| --- | --- | --- |
| Seeder | World and generation | None |
| Level design | World and generation | Seeder (seeded layouts) |
| D&D combat system | Systems and mechanics | Seeder (combat rolls) |
| Loot roller | Systems and mechanics | Seeder (hard dependency, built on it); listens for combat's enemy-defeated event |
| Inventory | Systems and mechanics | Shared item schema; receives loot roller drops |
| Concept art → 3D pipeline | Asset pipelines | GPT, Meshy, Blender cleanup |
| GBA-style basic animation | Presentation | None |
| UI/HUD kit | Presentation | Inventory and combat events |

Seeder + combat + loot + inventory + HUD already form the core loop of a roguelike dungeon crawler.

**Seeder convention: sub-streams.** Each consumer gets its own sub-stream derived from the main seed (loot, level layout, combat rolls, and so on). Adding an enemy to a level then never shifts later loot drops, and saved runs stay reproducible as the game changes.

**Shared contracts.** Modules talk only through these, never through each other's internals. This also keeps Godot and Three.js implementations aligned.

- **Item schema:** ID, rarity, stats, icon, 3D model reference
- **Events:** enemy defeated, item picked up, inventory changed

**Gaps to fill next**

- **Systems:** dialogue trees (pairs with ElevenLabs voices), save/load, quest tracking
- **Character control:** top-down, platformer and third-person controllers
- **Presentation:** camera rigs, cutscenes and scripted sequences
- **Pipelines:** voice-line batching, SFX sets, sprite-sheet generation for 2D

**Growth loop:** when a project invents something reusable, promote it into a new entry.

## Asset pipeline and external imports

Generated and imported assets share one pipeline end state: cleaned, bible-tagged, GLB or OGG, visible in the asset browser.

### Generated 3D: concept → Meshy → Blender

1. GPT generates an asset concept using the Meshy-friendly template
2. User approves the concept (it locks the look)
3. Meshy image-to-3D, plus texturing and rigging where needed
4. Blender headless cleanup: normalize scale and pivot, decimate to poly budget, snap materials to the bible palette, generate LODs, export GLB

Meshy-friendly concept template:

- Single object, centered, plain neutral background
- Front or three-quarter view, no perspective distortion or cropping
- Characters in A-pose or T-pose, no props overlapping the body
- Even lighting, no heavy shadows (they get baked into textures)

Approved concepts are stored in the bible as style references and passed into later generations.

**Animation:** humanoids use a retargeted animation library; non-humanoid rigging and animation remain a known weak spot.

**Asset cache:** within a project, a reused prop (e.g. "wooden crate") hits the cache instead of being generated again.

### External imports

Users upload music, SFX, 3D models, textures, fonts and reference images from outside sources.

- **Source and license required on upload:** purchased pack, commissioned, royalty-free site, or made in-house, plus the license terms
- **Processing by type:**
  - Music and SFX: normalize loudness, convert to OGG, set loop points for music
  - 3D models: same Blender cleanup as Meshy output
  - Images, textures, fonts: resize to budget, generate icons and thumbnails
- **Bible tagging:** assign to a mood, area or character ("boss battle music", "tavern ambience") so Claude can use it when building scenes
- **Locking:** imported assets are marked fixed; the agent never regenerates them
- **References:** uploaded sketches and mood images go into the bible as GPT style references

## Quality control

Checking output matters more than generating more of it; these checks run before any human playtest.

- **Automated playtesting:** run Godot headless and Three.js in a headless browser; a bot plays the game and flags crashes, softlocks and unreachable areas.
- **Visual checks:** screenshot each scene; Claude reviews it against the bible (off-palette assets, floating characters, wrong scale).
- **Balance simulation:** run thousands of seeded combats and loot rolls to catch broken difficulty or drop rates.
- **Performance budgets:** poly counts, draw calls and frame-rate targets per platform, flagged automatically.

## Human control

The user stays in charge of spend and direction.

- **Approval gates** before expensive steps (concepts → 3D, voice batches), each showing a cost estimate.
- **Direct editing:** move objects, tweak stats, or swap an asset in the editor without going through a prompt.
- **Branching and undo** on the Git-backed project folder ("try a harder version" without losing the current one).

## Production management

- **Asset browser:** every generated and imported asset with its status (concept, approved, 3D, cleaned, in game), source, license (imports), lock state, and the bible version it was built against.
- **Cost and credit tracking:** spend per project and per service (Anthropic, OpenAI, Meshy, ElevenLabs).
- **Task board:** what the agent is doing now and what is waiting on the user.

## Build priorities and first test

Build first: automated playtesting, approval gates with cost estimates, and the asset browser. These make everything else trustworthy.

**Minimum version:** a chat-plus-preview interface where a prompt produces a playable Three.js browser game, using Meshy assets cleaned in Blender, Claude-written game code and ElevenLabs SFX.

**First end-to-end test:** a roguelike dungeon crawler built from seeder + D&D combat + loot roller + inventory + UI/HUD kit, with level design and the concept-to-3D pipeline supplying the world.

## Open questions

- [ ] Bring-your-own API keys, or hosted with billing?
- [ ] Desktop app or web tool with shareable game links?
- [x] Bible file format: YAML or JSON? — **JSON for now** (parsed natively by Godot and the browser, no extra dependency). Revisit if hand-editing YAML matters more.
