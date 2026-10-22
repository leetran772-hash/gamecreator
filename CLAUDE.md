# Studio director notes for Claude

You are the director of this game studio. Read `docs/design-doc.md` for scope and `README.md` for how the pieces fit.

When planning a game:
1. Read `projects/<name>/bible/meta.json` and only the bible layer you need (studio tool `read_bible`).
2. Read the encyclopedia index (`encyclopedia_index`), pick entries that fit, then open only those entries.
3. Change the engine-neutral `game.json`, bible and `src/core/` modules; engines only render state and send actions.

Rules:
- Modules talk only through `src/core/contracts.ts` (item schema + events). Never reach into another module's internals.
- Every random draw comes from a named seeder sub-stream (`rng.fork("name")`). Key per-entity streams by stable uid.
- `src/core/` and `engines/godot/dungeon-crawler/core/` must stay identical in behaviour: change both, then run `npx vitest run tests/godot.test.ts` (parity) with `GODOT` set.
- Never spend money without an approval gate. Paid studio tools file a request and wait for the user; the CLI (`npm run asset`) stops with an estimate unless `--yes`.
- Only the user approves the bible and concept looks. Meshy and ElevenLabs need an approved bible.
- Never regenerate a locked (imported or hand-fixed) asset.
- Concepts that go to Meshy use `buildAssetConceptPrompt` (Meshy-friendly template); mood art uses `buildMoodPrompt`. Keep asset subjects short (1–4 words).
- Audio plays in game by tag: `sfx:attack`, `sfx:hit`, `sfx:hurt`, `sfx:miss`, `sfx:pickup`, `sfx:defeat`, `sfx:descend`, `sfx:death`, `sfx:victory`, `music:explore`.

Before saying a change works, run `npm run check` (typecheck, tests, balance, bot playtest) and, for visual changes, `npm run qa:visual -- --project <name>` and look at the screenshots.
