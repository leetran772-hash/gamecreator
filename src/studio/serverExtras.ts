// Extra API routes: audio generation, external imports, bible versioning, asset QA.
import { mkdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { basename, join } from "node:path";
import { AudioPipeline, dryRunAudioClients, liveAudioClients } from "../pipeline/audioPipeline";
import { bumpBibleVersion, staleAssets } from "../pipeline/bibleVersion";
import { estimateMusic, estimateSfx, estimateVoiceLines } from "../pipeline/gates";
import { importAsset, IMPORT_TYPES, type ImportAs } from "../pipeline/imports";
import { checkProjectAssets } from "../qa/assets";
import type { Studio } from "./server";

export interface RouteContext {
  studio: Studio;
  name: string;
  dir: string;
  req: IncomingMessage;
  url: URL;
  sub?: string;
  readJson: () => Promise<Record<string, unknown>>;
  readBody: () => Promise<Buffer>;
}

export interface Route {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Third path segment: /api/p/<project>/<path>/<sub> */
  path: string;
  sub?: string;
  handler: (ctx: RouteContext) => Promise<unknown> | unknown;
}

const tagsOf = (v: unknown) =>
  (Array.isArray(v) ? v : String(v ?? "").split(","))
    .map((t) => String(t).trim())
    .filter(Boolean);

export function registerExtraRoutes(studio: Studio) {
  const audio = (dir: string, log?: (m: string) => void) =>
    new AudioPipeline(dir, studio.opts.dryRunTools ? dryRunAudioClients() : liveAudioClients(), undefined, log);
  const add = (r: Route) => studio.routes.push(r);

  add({ method: "GET", path: "audio-estimates", handler: () => ({ sfx: estimateSfx(), music60: estimateMusic(60) }) });

  // The user clicking "Generate" (after seeing the estimate) is the approval.
  add({
    method: "POST",
    path: "sfx",
    handler: async ({ name, dir, readJson }) => {
      const b = await readJson();
      return studio.job(name, `SFX: ${b.description}`, async (log) =>
        (await audio(dir, log).sfx(String(b.description), { approved: true, tags: tagsOf(b.tags), durationSeconds: b.durationSeconds ? Number(b.durationSeconds) : undefined, force: !!b.force })).asset,
      );
    },
  });
  add({
    method: "POST",
    path: "music",
    handler: async ({ name, dir, readJson }) => {
      const b = await readJson();
      return studio.job(name, `Music: ${b.mood}`, async (log) =>
        (await audio(dir, log).music(String(b.mood), { approved: true, seconds: b.seconds ? Number(b.seconds) : undefined, tags: tagsOf(b.tags), force: !!b.force })).asset,
      );
    },
  });
  add({
    method: "POST",
    path: "voices",
    handler: async ({ name, dir, readJson }) => {
      const b = await readJson();
      const lines = (b.lines as { characterId: string; text: string }[]) ?? [];
      estimateVoiceLines(lines);
      return studio.job(name, `${lines.length} voice line(s)`, async (log) => audio(dir, log).voiceBatch(lines, { approved: true }));
    },
  });

  // Raw upload: body is the file, metadata in the query string.
  add({
    method: "POST",
    path: "import",
    handler: async ({ name, dir, url, readBody }) => {
      const q = url.searchParams;
      const filename = basename(q.get("filename") ?? "upload.bin").replace(/[^\w.\- ]+/g, "_");
      const as = q.get("as") || undefined;
      if (as && !IMPORT_TYPES.includes(as as ImportAs)) throw new Error(`"as" must be one of ${IMPORT_TYPES.join(", ")}`);
      const origin = q.get("origin") ?? "";
      const license = q.get("license") ?? "";
      if (!origin || !license) throw new Error("Source and license are required for every import.");
      const body = await readBody();
      const uploads = join(dir, ".studio", "uploads");
      mkdirSync(uploads, { recursive: true });
      const file = join(uploads, `${Date.now()}-${filename}`);
      writeFileSync(file, body);
      return studio.job(name, `Import: ${filename}`, async (log) => {
        log(`Processing ${filename} (${(body.length / 1024).toFixed(0)} KB)...`);
        return importAsset(dir, file, {
          origin,
          license,
          as: as as ImportAs | undefined,
          tags: tagsOf(q.get("tags")),
          subject: q.get("subject") || undefined,
          modelKind: (q.get("modelKind") as never) || undefined,
        });
      });
    },
  });

  add({ method: "GET", path: "stale", handler: ({ dir }) => staleAssets(dir) });
  add({ method: "POST", path: "bump-bible", handler: ({ dir }) => ({ version: bumpBibleVersion(dir) }) });
  add({
    method: "POST",
    path: "rematerial",
    sub: "*",
    handler: ({ name, sub }) => studio.job(name, `Re-material: ${sub}`, async (log) => studio.pipeline(name, log).rematerial(String(sub))),
  });
  add({ method: "GET", path: "asset-qa", handler: ({ dir }) => checkProjectAssets(dir) });
}
