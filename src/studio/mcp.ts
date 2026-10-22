// Studio tools for Claude Code, served over MCP (stdio). Claude is the
// director; these are the specialist tools it calls. Paid steps never run on
// the agent's say-so: they create an approval request with a cost estimate,
// and only run once the user approves it in the studio.
//
// Run: STUDIO_PROJECT_DIR=projects/<name> npx tsx src/studio/mcp.ts
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Bible } from "../bible/types";
import { AssetPipeline, dryRunClients, liveClients, loadBibleFrom } from "../pipeline/assetPipeline";
import { buildMoodPrompt } from "../pipeline/conceptPrompt";
import { estimateConcept, estimateMeshy, type Estimate } from "../pipeline/gates";
import { loadRegistry } from "../pipeline/registry";
import { consumeApproval, pendingApprovals, requestApproval } from "./approvals";
import { LAYERS, readLayer, setEntityModel, writeLayer, type Layer } from "./bible";
import { checkpoint } from "./git";
import { costSummary } from "./ledger";
import { REPO_ROOT } from "./projects";
import { loadTasks, setPlan, waitingOnUser } from "./tasks";
import { registerExtraTools } from "./mcpExtras";

const run = promisify(execFile);

export interface ToolContext {
  dir: string;
  dryRun: boolean;
  pipeline: AssetPipeline;
  text: (s: string) => { content: { type: "text"; text: string }[] };
  json: (v: unknown) => { content: { type: "text"; text: string }[] };
  /** Runs `fn` if the user approved this exact action; otherwise files an approval request. */
  gated: (
    tool: string,
    args: Record<string, unknown>,
    estimate: Estimate,
    summary: string,
    fn: () => Promise<unknown>,
  ) => Promise<{ content: { type: "text"; text: string }[] }>;
  requireApprovedBible: () => void;
}

export function buildServer(dir: string, dryRun = process.env.STUDIO_DRY_RUN === "1"): McpServer {
  const server = new McpServer({ name: "studio", version: "0.1.0" });
  const pipeline = new AssetPipeline(dir, dryRun ? dryRunClients() : liveClients());
  const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
  const json = (v: unknown) => text(JSON.stringify(v, null, 2));
  const requireApprovedBible = () => {
    const meta = readLayer(dir, "meta") as Bible["meta"];
    if (!meta.approved) throw new Error("The user has not approved the bible yet. Ask them to review it in the Bible tab first.");
  };
  const gated: ToolContext["gated"] = async (tool, args, estimate, summary, fn) => {
    if (consumeApproval(dir, { tool, args })) return json({ ok: true, result: await fn() });
    const req = requestApproval(dir, estimate, { tool, args }, summary);
    return text(
      `Needs the user's approval first (request ${req.id}: ${summary}, est. $${estimate.usd.toFixed(2)}). ` +
        `It is shown in the studio's approval queue. Don't retry until the user says it's approved; continue with other work or ask them.`,
    );
  };
  const ctx: ToolContext = { dir, dryRun, pipeline, text, json, gated, requireApprovedBible };

  server.registerTool(
    "studio_status",
    { description: "Project overview: bible title/version/approval, asset counts by status, pending approvals, spend, task board, what waits on the user." },
    async () => {
      const meta = readLayer(dir, "meta") as Bible["meta"];
      const assets = loadRegistry(dir).assets;
      const byStatus: Record<string, number> = {};
      for (const a of assets) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
      return json({ meta, assets: byStatus, pendingApprovals: pendingApprovals(dir), costs: costSummary(dir), tasks: loadTasks(dir), waitingOnUser: waitingOnUser(dir), dryRun });
    },
  );

  server.registerTool(
    "read_bible",
    { description: `Read one bible layer (${LAYERS.join(", ")}). Read only the layer you need.`, inputSchema: { layer: z.enum(LAYERS) } },
    async ({ layer }) => json(readLayer(dir, layer)),
  );

  server.registerTool(
    "write_bible",
    {
      description:
        "Replace one bible layer with new JSON (whole layer). Validated before saving; bumps the bible version. You cannot approve the bible: only the user can.",
      inputSchema: { layer: z.enum(LAYERS), data: z.record(z.string(), z.unknown()) },
    },
    async ({ layer, data }) => json(writeLayer(dir, layer as Layer, data, "agent")),
  );

  server.registerTool(
    "encyclopedia_index",
    { description: "The studio's encyclopedia index: reusable modules it knows how to build. Read while planning." },
    async () => text(readFileSync(join(REPO_ROOT, "encyclopedia", "index.json"), "utf8")),
  );

  server.registerTool(
    "encyclopedia_entry",
    { description: "One encyclopedia entry (inputs, outputs, implementations, dependencies, gotchas).", inputSchema: { id: z.string() } },
    async ({ id }) => {
      const f = join(REPO_ROOT, "encyclopedia", "entries", `${id.replace(/[^a-z0-9-]/gi, "")}.json`);
      if (!existsSync(f)) throw new Error(`No encyclopedia entry "${id}"`);
      return text(readFileSync(f, "utf8"));
    },
  );

  server.registerTool(
    "list_assets",
    { description: "Asset browser data: every asset with status, source, license, lock, bible version and spend." },
    async () => json(loadRegistry(dir).assets),
  );

  server.registerTool(
    "generate_concept",
    {
      description:
        "Generate a GPT asset concept image (Meshy-friendly template + bible style + approved concepts as references). Reused subjects hit the cache. Paid: needs user approval. The user then approves the look in the studio before it can go to 3D.",
      inputSchema: {
        subject: z.string(),
        kind: z.enum(["character", "creature", "prop", "environment"]),
        description: z.string().optional(),
      },
    },
    async (args) => {
      const reg = loadRegistry(dir);
      const hit = reg.assets.find((a) => a.subject.trim().toLowerCase() === args.subject.trim().toLowerCase() && a.status !== "concept");
      if (hit) return json({ cached: true, asset: hit });
      return gated("generate_concept", args, estimateConcept(), `Concept image: ${args.subject}`, async () =>
        (await pipeline.concept(args.subject, { kind: args.kind, description: args.description, approved: true })).asset,
      );
    },
  );

  server.registerTool(
    "generate_mood_art",
    {
      description: "Generate mood art / key art for the bible (separate template from asset concepts; never sent to Meshy). Paid: needs approval.",
      inputSchema: { scene: z.string() },
    },
    async (args) =>
      gated("generate_mood_art", args, { ...estimateConcept(), step: "mood-art", detail: "1 mood image" }, `Mood art: ${args.scene}`, async () => {
        const bible = loadBibleFrom(dir);
        const png = await (dryRun ? dryRunClients() : liveClients()).image(buildMoodPrompt(bible, args.scene), []);
        const id = `mood-${Date.now().toString(36)}`;
        const rel = `bible/concepts/${id}.png`;
        mkdirSync(join(dir, "bible", "concepts"), { recursive: true });
        writeFileSync(join(dir, rel), png);
        const visual = readLayer(dir, "visual") as Bible["visual"];
        visual.concepts.push({ id, image: rel, kind: "mood", subject: args.scene, approved: false, bibleVersion: bible.meta.version });
        writeLayer(dir, "visual", visual, "agent");
        return { image: rel };
      }),
  );

  server.registerTool(
    "make_3d",
    {
      description: "Send an approved concept to Meshy image-to-3D (the concept image is the input), then run Blender cleanup. Needs an approved bible, an approved concept, and spend approval.",
      inputSchema: { id: z.string() },
    },
    async (args) => {
      requireApprovedBible();
      const asset = loadRegistry(dir).assets.find((a) => a.id === args.id);
      if (!asset) throw new Error(`No asset ${args.id}`);
      if (asset.status === "concept") throw new Error(`The user hasn't approved the concept for ${args.id} yet.`);
      return gated("make_3d", args, estimateMeshy(), `Meshy 3D model: ${asset.subject}`, async () => {
        await pipeline.to3d(args.id, true);
        return pipeline.cleanup(args.id);
      });
    },
  );

  server.registerTool(
    "cleanup_model",
    { description: "Re-run local Blender cleanup on an asset's raw model (free).", inputSchema: { id: z.string() } },
    async ({ id }) => json(pipeline.cleanup(id)),
  );

  server.registerTool(
    "set_entity_model",
    {
      description: 'Use a cleaned asset in the game: point a bible entity ("player", an enemy id, or an item id) at an asset\'s model.',
      inputSchema: { entity: z.string(), assetId: z.string() },
    },
    async ({ entity, assetId }) => {
      const a = loadRegistry(dir).assets.find((x) => x.id === assetId);
      if (!a?.model) throw new Error(`${assetId} has no cleaned model yet`);
      return json(setEntityModel(dir, entity, a.model, "agent"));
    },
  );

  server.registerTool(
    "run_qa",
    { description: "Bible validation, balance simulation and bot playtests (crashes, softlocks, unreachable areas). Run after every gameplay change.", inputSchema: { runs: z.number().int().min(10).max(1000).optional() } },
    async ({ runs }) => {
      const args = ["tsx", "scripts/qa.ts", "--project", dir, ...(runs ? ["--runs", String(runs)] : [])];
      try {
        const { stdout } = await run("npx", args, { cwd: REPO_ROOT, maxBuffer: 1 << 24 });
        return text(stdout);
      } catch (e) {
        return text(`QA FAILED\n${(e as { stdout?: string }).stdout ?? e}`);
      }
    },
  );

  server.registerTool(
    "visual_check",
    {
      description: "Play the Three.js build in headless Chromium (desktop + phone), check console errors and performance budgets, save screenshots. Then Read the screenshots and review them against the bible (off-palette, floating, wrong scale).",
    },
    async () => {
      const name = resolve(dir).split("/").pop()!;
      const out = join(dir, ".studio", "screenshots");
      try {
        const { stdout } = await run("npx", ["tsx", "scripts/visual.ts", "--project", name, "--out", out], { cwd: REPO_ROOT, maxBuffer: 1 << 24 });
        return text(`${stdout}\nScreenshots: ${out}/${name}-*.png`);
      } catch (e) {
        return text(`VISUAL CHECK FAILED\n${(e as { stdout?: string }).stdout ?? e}`);
      }
    },
  );

  server.registerTool(
    "update_task_board",
    {
      description: "Replace your plan on the studio task board so the user sees what you are doing and what is next.",
      inputSchema: {
        items: z.array(z.object({ title: z.string(), status: z.enum(["todo", "doing", "done", "blocked"]), note: z.string().optional() })),
      },
    },
    async ({ items }) => {
      setPlan(dir, items);
      return text("Task board updated.");
    },
  );

  server.registerTool(
    "checkpoint",
    { description: "Save a checkpoint (git commit) of the project folder so the user can undo back to it.", inputSchema: { message: z.string() } },
    async ({ message }) => text(checkpoint(dir, message) ? "Checkpoint saved." : "Nothing changed since the last checkpoint."),
  );

  registerExtraTools(server, ctx);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("src/studio/mcp.ts")) {
  const dir = process.env.STUDIO_PROJECT_DIR;
  if (!dir) {
    console.error("Set STUDIO_PROJECT_DIR to the project folder.");
    process.exit(1);
  }
  const server = buildServer(resolve(dir));
  await server.connect(new StdioServerTransport());
}
