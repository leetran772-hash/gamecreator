// Studio server: chat-plus-preview app. Serves the studio UI and the live
// game preview (through Vite), a JSON API over project folders, and a
// server-sent event stream with director output, job logs and state changes.
//
//   npm run studio            (http://localhost:4400)
//   npm run studio -- --dry-run-tools   (paid tools use placeholders)
import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, watch } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { createServer as createVite } from "vite";
import type { Bible } from "../bible/types";
import { validateBible } from "../bible/validate";
import { AssetPipeline, dryRunClients, liveClients, loadBibleFrom } from "../pipeline/assetPipeline";
import type { AssetKind } from "../pipeline/conceptPrompt";
import { ApprovalRequired, estimateConcept, estimateMeshy } from "../pipeline/gates";
import { loadRegistry } from "../pipeline/registry";
import { decide, loadApprovals } from "./approvals";
import { LAYERS, setBibleApproved, setEntityModel, writeLayer, type Layer } from "./bible";
import { Director } from "./director";
import { branch, branches, checkpoint, currentBranch, history, restore, switchBranch } from "./git";
import { costSummary, loadLedger } from "./ledger";
import { createProject, listProjects, PROJECTS_DIR, projectDir, REPO_ROOT, STARTERS, type Starter } from "./projects";
import { loadTasks, waitingOnUser } from "./tasks";
import { registerExtraRoutes, type Route } from "./serverExtras";

export interface StudioOptions {
  port?: number;
  dryRunTools?: boolean;
  claudeBin?: string;
  projectsRoot?: string;
  /** Serve the UI and preview through Vite (off in API tests). */
  vite?: boolean;
}

type Json = Record<string, unknown>;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readBody(req: IncomingMessage, limit = 200 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, "Upload too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

const readJson = async (req: IncomingMessage): Promise<Json> => {
  const b = await readBody(req, 5 * 1024 * 1024);
  if (!b.length) return {};
  try {
    return JSON.parse(b.toString()) as Json;
  } catch {
    throw new HttpError(400, "Body is not valid JSON");
  }
};

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".glb": "model/gltf-binary",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".json": "application/json",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

export interface Job {
  id: string;
  project: string;
  title: string;
  status: "running" | "done" | "failed";
  log: string[];
  result?: unknown;
}

export class Studio {
  readonly root: string;
  private directors = new Map<string, Director>();
  private sse = new Map<string, Set<ServerResponse>>();
  private watchers = new Map<string, ReturnType<typeof watch>>();
  readonly jobs = new Map<string, Job>();
  private jobSeq = 0;
  readonly routes: Route[] = [];

  constructor(readonly opts: StudioOptions = {}) {
    this.root = opts.projectsRoot ?? PROJECTS_DIR;
    registerExtraRoutes(this);
  }

  dir(name: string) {
    const d = projectDir(name, this.root);
    if (!existsSync(join(d, "bible", "meta.json"))) throw new HttpError(404, `No project "${name}"`);
    return d;
  }

  pipeline(name: string, log?: (m: string) => void) {
    return new AssetPipeline(this.dir(name), this.opts.dryRunTools ? dryRunClients() : liveClients(), undefined, log);
  }

  director(name: string): Director {
    let d = this.directors.get(name);
    if (!d) {
      d = new Director(this.dir(name), { claudeBin: this.opts.claudeBin, dryRunTools: this.opts.dryRunTools });
      d.on((e) => this.broadcast(name, "director", e));
      this.directors.set(name, d);
    }
    return d;
  }

  broadcast(name: string, event: string, data: unknown) {
    for (const res of this.sse.get(name) ?? []) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private watchProject(name: string) {
    if (this.watchers.has(name)) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      const w = watch(this.dir(name), { recursive: true }, (_e, file) => {
        if (file && String(file).includes("node_modules")) return;
        clearTimeout(timer);
        timer = setTimeout(() => this.broadcast(name, "state", { changed: String(file ?? "") }), 150);
      });
      this.watchers.set(name, w);
    } catch {
      /* watching is a convenience */
    }
  }

  /** Runs work in the background with a log the UI can follow. */
  job(project: string, title: string, fn: (log: (m: string) => void) => Promise<unknown>): Job {
    const job: Job = { id: `job-${++this.jobSeq}`, project, title, status: "running", log: [] };
    this.jobs.set(job.id, job);
    const log = (m: string) => {
      job.log.push(m);
      this.broadcast(project, "job", { id: job.id, title, status: job.status, line: m });
    };
    this.broadcast(project, "job", { id: job.id, title, status: "running" });
    fn(log)
      .then((r) => {
        job.status = "done";
        job.result = r;
        this.broadcast(project, "job", { id: job.id, title, status: "done" });
      })
      .catch((e: Error) => {
        job.status = "failed";
        log(e instanceof ApprovalRequired ? e.message : String(e.message ?? e));
        this.broadcast(project, "job", { id: job.id, title, status: "failed" });
      });
    return job;
  }

  /** Runs a repo script and streams its output into a job log. */
  script(project: string, title: string, args: string[]): Job {
    return this.job(project, title, (log) => {
      return new Promise((resolveP, reject) => {
        const p = spawn(process.execPath, [join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), ...args], { cwd: REPO_ROOT, env: process.env });
        const onData = (c: Buffer) => c.toString().split("\n").filter((l) => l.trim()).forEach(log);
        p.stdout.on("data", onData);
        p.stderr.on("data", onData);
        p.on("close", (code) => (code === 0 ? resolveP({ code }) : reject(new Error(`${title} failed (exit ${code})`))));
      });
    });
  }

  state(name: string) {
    const dir = this.dir(name);
    const bible = loadBibleFrom(dir) as Bible;
    let git: unknown = null;
    try {
      git = { branch: currentBranch(dir), branches: branches(dir), history: history(dir, 20) };
    } catch {
      git = null;
    }
    const assets = loadRegistry(dir).assets;
    const d = this.directors.get(name);
    return {
      name,
      bible,
      problems: validateBible(bible),
      assets,
      stale: assets.filter((a) => !a.locked && a.bibleVersion < bible.meta.version).map((a) => a.id),
      approvals: loadApprovals(dir).slice(-50),
      costs: { ...costSummary(dir), ledger: loadLedger(dir).slice(-50) },
      tasks: loadTasks(dir),
      waiting: waitingOnUser(dir),
      git,
      chat: { running: !!d?.running, history: (d ?? this.director(name)).history().slice(-200) },
      jobs: [...this.jobs.values()].filter((j) => j.project === name).slice(-10),
      estimates: { concept: estimateConcept(), meshy: estimateMeshy() },
      screenshots: listScreenshots(dir),
      dryRunTools: !!this.opts.dryRunTools,
    };
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://x");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const method = req.method ?? "GET";

    if (parts[0] === "files" && parts[1]) return this.serveFile(parts[1], parts.slice(2), res);
    if (parts[0] !== "api") return false;
    const [, a, name, b, c] = parts;

    if (a === "projects" && !name) {
      if (method === "GET") return send(res, 200, { projects: listProjects(this.root), starters: STARTERS }), true;
      if (method === "POST") {
        const body = await readJson(req);
        const dir = createProject(
          { name: String(body.name ?? ""), starter: String(body.starter ?? "dark-fantasy") as Starter, pitch: body.pitch as string, title: body.title as string },
          this.root,
        );
        try {
          checkpoint(dir, `New project ${body.name}`);
        } catch {
          /* not in a git repo */
        }
        const n = String(body.name);
        if (body.pitch && body.startDirector !== false) {
          void this.director(n)
            .send(onboardingMessage(String(body.pitch)))
            .catch(() => {});
        }
        return send(res, 201, { name: n }), true;
      }
    }

    if (a !== "p" || !name) throw new HttpError(404, "Not found");
    const dir = this.dir(name);

    for (const r of this.routes) {
      if (r.method === method && r.path === b && (r.sub === undefined || r.sub === c || r.sub === "*")) {
        const out = await r.handler({ studio: this, name, dir, req, url, sub: c, readJson: () => readJson(req), readBody: () => readBody(req) });
        send(res, 200, out ?? { ok: true });
        return true;
      }
    }

    switch (`${method} ${b ?? ""}`) {
      case "GET state":
        return send(res, 200, this.state(name)), true;

      case "GET events": {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(`event: hello\ndata: {}\n\n`);
        let set = this.sse.get(name);
        if (!set) this.sse.set(name, (set = new Set()));
        set.add(res);
        this.watchProject(name);
        const ping = setInterval(() => res.write(": ping\n\n"), 20000);
        req.on("close", () => {
          clearInterval(ping);
          set!.delete(res);
        });
        return true;
      }

      case "PUT bible": {
        if (!LAYERS.includes(c as Layer)) throw new HttpError(400, "Unknown layer");
        const out = writeLayer(dir, c as Layer, await readJson(req), "user");
        return send(res, 200, out), true;
      }

      case "POST bible-approval": {
        const body = await readJson(req);
        setBibleApproved(dir, !!body.approved);
        if (body.approved) checkpoint(dir, "Bible approved");
        return send(res, 200, { ok: true }), true;
      }

      case "POST approvals": {
        const body = await readJson(req);
        const r = decide(dir, String(c), !!body.approve);
        const d = this.director(name);
        if (body.notifyDirector !== false && !d.running)
          void d.send(`[studio] The user ${r.status} request ${r.id} (${r.summary}).${r.status === "approved" ? " Run it now." : ""}`).catch(() => {});
        return send(res, 200, r), true;
      }

      case "POST chat": {
        const body = await readJson(req);
        const msg = String(body.message ?? "").trim();
        if (!msg) throw new HttpError(400, "Empty message");
        const d = this.director(name);
        if (d.running) throw new HttpError(409, "The director is still working on the last message.");
        void d.send(msg).catch(() => {});
        return send(res, 202, { ok: true }), true;
      }

      case "POST chat-stop":
        this.director(name).stop();
        return send(res, 200, { ok: true }), true;

      case "POST concept": {
        const body = await readJson(req);
        const job = this.job(name, `Concept: ${body.subject}`, async (log) =>
          (await this.pipeline(name, log).concept(String(body.subject), { kind: (body.kind as AssetKind) ?? "prop", description: body.description as string, approved: true, force: !!body.force })).asset,
        );
        return send(res, 202, job), true;
      }

      case "POST approve-concept":
        return send(res, 200, this.pipeline(name).approve(String(c))), true;

      case "POST make3d": {
        const id = String(c);
        const meta = (loadBibleFrom(dir) as Bible).meta;
        if (!meta.approved) throw new HttpError(409, "Approve the bible first (Bible tab).");
        const job = this.job(name, `3D model: ${id}`, async (log) => {
          const p = this.pipeline(name, log);
          await p.to3d(id, true);
          return p.cleanup(id);
        });
        return send(res, 202, job), true;
      }

      case "POST cleanup": {
        const id = String(c);
        const job = this.job(name, `Blender cleanup: ${id}`, async (log) => this.pipeline(name, log).cleanup(id));
        return send(res, 202, job), true;
      }

      case "POST entity-model": {
        const body = await readJson(req);
        const asset = body.assetId ? loadRegistry(dir).assets.find((x) => x.id === body.assetId) : undefined;
        if (body.assetId && !asset?.model) throw new HttpError(400, "That asset has no cleaned model yet");
        return send(res, 200, setEntityModel(dir, String(body.entity), asset?.model, "user")), true;
      }

      case "POST qa": {
        const job = this.script(name, "QA: balance + bot playtest", ["scripts/qa.ts", "--project", dir]);
        return send(res, 202, job), true;
      }

      case "POST visual": {
        const job = this.script(name, "Visual check", ["scripts/visual.ts", "--project", name, "--out", join(dir, ".studio", "screenshots")]);
        return send(res, 202, job), true;
      }

      case "POST git": {
        const body = await readJson(req);
        if (c === "checkpoint") return send(res, 200, { commit: checkpoint(dir, String(body.message || "Checkpoint")) }), true;
        if (c === "restore") return send(res, 200, { commit: restore(dir, String(body.commit)) }), true;
        if (c === "branch") return send(res, 200, { branch: branch(dir, String(body.name)) }), true;
        if (c === "switch") return switchBranch(dir, String(body.name)), send(res, 200, { ok: true }), true;
        throw new HttpError(404, "Unknown git action");
      }
    }
    throw new HttpError(404, `No route ${method} ${url.pathname}`);
  }

  private serveFile(name: string, path: string[], res: ServerResponse): boolean {
    const dir = this.dir(name);
    const file = normalize(join(dir, ...path));
    if (!file.startsWith(resolve(dir) + sep) || !existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, "No such file");
    res.writeHead(200, { "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    createReadStream(file).pipe(res);
    return true;
  }

  async listen(): Promise<{ port: number; close: () => Promise<void> }> {
    const port = this.opts.port ?? 4400;
    const server = createServer();
    const vite =
      this.opts.vite === false
        ? undefined
        : await createVite({ root: REPO_ROOT, appType: "mpa", server: { middlewareMode: true, hmr: { server } }, logLevel: "warn" });
    server.on("request", (req, res) => {
      // The studio lives at /, the game preview at /game (same page as the shareable build).
      const u = new URL(req.url ?? "/", "http://x");
      if (u.pathname === "/" || u.pathname === "/studio") req.url = "/studio.html" + u.search;
      else if (u.pathname === "/game") req.url = "/index.html" + u.search;
      this.handle(req, res)
        .then((handled) => {
          if (handled) return;
          if (vite) vite.middlewares(req, res, () => send(res, 404, { error: "Not found" }));
          else send(res, 404, { error: "Not found" });
        })
        .catch((e: Error) => {
          if (res.headersSent) return res.end();
          send(res, e instanceof HttpError ? e.status : 500, { error: e.message });
        });
    });
    await new Promise<void>((r) => server.listen(port, r));
    const actual = (server.address() as { port: number }).port;
    return {
      port: actual,
      close: async () => {
        for (const w of this.watchers.values()) w.close();
        for (const set of this.sse.values()) for (const r of set) r.end();
        for (const d of this.directors.values()) d.stop();
        await vite?.close();
        await new Promise<void>((r) => server.close(() => r()));
      },
    };
  }
}

function listScreenshots(dir: string): string[] {
  const d = join(dir, ".studio", "screenshots");
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".png")).sort().map((f) => `.studio/screenshots/${f}`) : [];
}

export function onboardingMessage(pitch: string) {
  return `New project. The user's pitch: "${pitch}"

Onboarding: draft this project's bible from the pitch, starting from the starter bible already in the folder.
1. Read the encyclopedia index and pick the modules that fit (the dungeon-crawler template is what exists today).
2. Rewrite meta (title, pitch, genre, style), lore (tone, rules, factions, characters, player, bestiary, items, loot tables), visual (palette, materials, style notes) and audio (voice notes per character, SFX style, music moods) to fit the pitch. Keep all references valid.
3. Request 2-3 cheap concept images (generate_concept / generate_mood_art) for the key look; they wait for the user's approval.
4. Run run_qa so the balance is sane, then checkpoint.
5. Tell the user, briefly, what you drafted and that they should review and approve the bible in the Bible tab before any Meshy or ElevenLabs spend.`;
}

if (process.argv[1]?.endsWith("src/studio/server.ts")) {
  const { values } = parseArgs({
    options: { port: { type: "string", default: "4400" }, "dry-run-tools": { type: "boolean", default: false }, claude: { type: "string" } },
  });
  mkdirSync(PROJECTS_DIR, { recursive: true });
  const studio = new Studio({ port: Number(values.port), dryRunTools: values["dry-run-tools"], claudeBin: values.claude });
  const { port } = await studio.listen();
  console.log(`Studio running at http://localhost:${port}${values["dry-run-tools"] ? "  (paid tools in dry-run mode)" : ""}`);
}

