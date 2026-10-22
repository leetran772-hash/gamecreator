// Audio, versioning and asset-QA tools for the director.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AudioPipeline, dryRunAudioClients, liveAudioClients } from "../pipeline/audioPipeline";
import { staleAssets } from "../pipeline/bibleVersion";
import { combineEstimates, estimateConcept, estimateMeshy, estimateMusic, estimateSfx, estimateVoiceLines } from "../pipeline/gates";
import { loadRegistry } from "../pipeline/registry";
import { checkProjectAssets } from "../qa/assets";
import type { ToolContext } from "./mcp";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { exportGodot } from "../../scripts/export-godot";
import { REPO_ROOT } from "./projects";

const run = promisify(execFile);

export const EVENT_TAGS =
  'Tags that the game plays automatically: "sfx:attack", "sfx:hit", "sfx:hurt", "sfx:miss", "sfx:pickup", "sfx:defeat", "sfx:descend", "sfx:death", "sfx:victory", "music:explore".';

export function registerExtraTools(server: McpServer, ctx: ToolContext) {
  const { dir, gated, json, requireApprovedBible } = ctx;
  const audio = () => new AudioPipeline(dir, ctx.dryRun ? dryRunAudioClients() : liveAudioClients());

  server.registerTool(
    "generate_sfx",
    {
      description: `ElevenLabs sound effect in the bible's SFX style, finished to loudness-normalized OGG. Paid: needs approval and an approved bible. ${EVENT_TAGS}`,
      inputSchema: { description: z.string(), tags: z.array(z.string()).optional(), durationSeconds: z.number().min(0.5).max(30).optional() },
    },
    async (args) => {
      requireApprovedBible();
      return gated("generate_sfx", args, estimateSfx(), `Sound effect: ${args.description}`, async () =>
        (await audio().sfx(args.description, { approved: true, tags: args.tags, durationSeconds: args.durationSeconds })).asset,
      );
    },
  );

  server.registerTool(
    "generate_music",
    {
      description: `ElevenLabs music for a bible mood (audio.musicMoods key like "explore" or "combat"), finished to OGG with loop points. Paid: needs approval and an approved bible. ${EVENT_TAGS}`,
      inputSchema: { mood: z.string(), seconds: z.number().min(5).max(300).optional(), tags: z.array(z.string()).optional() },
    },
    async (args) => {
      requireApprovedBible();
      return gated("generate_music", args, estimateMusic(args.seconds ?? 60), `Music: ${args.mood} (${args.seconds ?? 60}s)`, async () =>
        (await audio().music(args.mood, { approved: true, seconds: args.seconds, tags: args.tags })).asset,
      );
    },
  );

  server.registerTool(
    "voice_lines",
    {
      description:
        "Batch of character voice lines with each character's fixed bible voice ID (audio.voices). One approval covers the whole batch. Characters without a voice ID are refused: ask the user to set them.",
      inputSchema: { lines: z.array(z.object({ characterId: z.string(), text: z.string(), tags: z.array(z.string()).optional() })).min(1) },
    },
    async (args) => {
      requireApprovedBible();
      const reg = loadRegistry(dir);
      const todo = args.lines.filter((l) => !reg.assets.some((a) => a.voice?.characterId === l.characterId && a.voice?.text === l.text));
      if (!todo.length) return json({ cached: true });
      return gated("voice_lines", args, estimateVoiceLines(todo), `${todo.length} voice line(s)`, async () => audio().voiceBatch(args.lines, { approved: true }));
    },
  );

  server.registerTool(
    "stale_assets",
    { description: "Assets built against an older bible version, with the suggested fix (free rematerial vs paid regenerate)." },
    async () => json(staleAssets(dir)),
  );

  server.registerTool(
    "rematerial",
    { description: "Free: re-run Blender cleanup on a stale model so its materials snap to the current bible palette.", inputSchema: { id: z.string() } },
    async ({ id }) => json(ctx.pipeline.rematerial(id)),
  );

  server.registerTool(
    "regenerate",
    { description: "Paid: regenerate an asset from scratch against the current bible (concept + 3D, or audio). Needs approval.", inputSchema: { id: z.string() } },
    async ({ id }) => {
      const a = loadRegistry(dir).assets.find((x) => x.id === id);
      if (!a) throw new Error(`No asset ${id}`);
      if (a.locked) throw new Error(`${id} is locked (imported or hand-fixed); it is never regenerated.`);
      const isAudio = a.kind === "sfx" || a.kind === "music" || a.kind === "voice";
      const est = isAudio
        ? a.kind === "music"
          ? estimateMusic(a.audio?.duration ?? 60)
          : a.kind === "voice"
            ? estimateVoiceLines([{ text: a.voice?.text ?? "" }])
            : estimateSfx()
        : combineEstimates("regenerate", [estimateConcept(), estimateMeshy()]);
      return gated("regenerate", { id }, est, `Regenerate ${a.subject}`, async () => (isAudio ? audio().regenerate(id, true) : ctx.pipeline.regenerate(id, true)));
    },
  );

  server.registerTool(
    "export_godot",
    {
      description:
        "Write a Godot 4 project for this game (genre template + this bible, game.json and cleaned models) to build/godot/<project>. The Godot port is kept identical to the TS core by parity tests.",
    },
    async () => {
      const name = dir.split("/").pop()!;
      return json(exportGodot({ project: dir, out: join(REPO_ROOT, "build", "godot", name) }));
    },
  );

  server.registerTool(
    "godot_qa",
    { description: "Run the bot playtest inside Godot headless and compare every run with the TS core. Needs GODOT set.", inputSchema: { runs: z.number().int().min(5).max(500).optional() } },
    async ({ runs }) => {
      if (!process.env.GODOT) return ctx.text("Godot isn't configured on this machine (set GODOT=/path/to/godot).");
      try {
        const { stdout } = await run("npx", ["tsx", "scripts/godot-qa.ts", "--project", dir, "--runs", String(runs ?? 50)], { cwd: REPO_ROOT, maxBuffer: 1 << 24 });
        return ctx.text(stdout);
      } catch (e) {
        return ctx.text(`GODOT QA FAILED\n${(e as { stdout?: string }).stdout ?? e}`);
      }
    },
  );

  server.registerTool(
    "check_assets",
    { description: "Asset QA: floating models, wrong scale, over poly budget, off-palette materials, broken audio or loop points." },
    async () => json(checkProjectAssets(dir)),
  );
}
