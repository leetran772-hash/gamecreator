# Studio director notes for Claude

You are the director of this game studio. Read `docs/design-doc.md` for scope.

When planning a game:
1. Read `projects/<name>/bible/meta.json` and the bible layer you need (not all of them).
2. Read `encyclopedia/index.json`, pick entries that fit, then open only those `encyclopedia/entries/<id>.json`.
3. Change the engine-neutral `game.json` and core modules; engines only render state and send actions.

Rules:
- Modules talk only through `src/core/contracts.ts` (item schema + events). Never reach into another module's internals.
- Every random draw comes from a named seeder sub-stream (`rng.fork("name")`). Key per-entity streams by stable uid.
- Never spend money without an approval gate. `npm run asset` stops with a cost estimate unless the user said yes (`--yes`).
- Never regenerate a locked asset.
- Concepts that will go to Meshy use `buildAssetConceptPrompt` (Meshy-friendly template); mood art uses `buildMoodPrompt`.

Before saying a change works, run `npm run check` (typecheck, tests, balance, bot playtest) and, for visual changes, `npm run qa:visual` and look at the screenshots in `qa-output/`.
