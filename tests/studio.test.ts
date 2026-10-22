import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Studio } from "../src/studio/server";
import { loadLedger } from "../src/studio/ledger";

// A stand-in for the claude CLI that prints a realistic stream-json turn.
const fakeClaude = () => {
  const dir = mkdtempSync(join(tmpdir(), "gc-claude-"));
  const bin = join(dir, "claude");
  const lines = [
    { type: "system", subtype: "init", session_id: "sess-123" },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Draft" } } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__studio__read_bible", input: { layer: "meta" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "{}" }] }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "I drafted the bible." }] } },
    { type: "result", subtype: "success", total_cost_usd: 0.42, session_id: "sess-123" },
  ];
  writeFileSync(bin, `#!/bin/sh\necho "$@" > "${dir}/args.txt"\ncat <<'EOF2'\n${lines.map((l) => JSON.stringify(l)).join("\n")}\nEOF2\n`);
  chmodSync(bin, 0o755);
  return { bin, argsFile: join(dir, "args.txt") };
};

let base = "";
let close: () => Promise<void>;
let root = "";
const claude = fakeClaude();

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "gc-studio-"));
  const studio = new Studio({ port: 0, vite: false, dryRunTools: true, projectsRoot: root, claudeBin: claude.bin });
  const s = await studio.listen();
  base = `http://localhost:${s.port}`;
  close = s.close;
});
afterAll(() => close?.());

const api = async (path: string, init: RequestInit & { json?: unknown } = {}) => {
  const res = await fetch(base + path, {
    ...init,
    headers: init.json !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const waitFor = async (fn: () => Promise<boolean>, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out");
};

describe("studio server", () => {
  it("creates a project from a starter and runs the onboarding director turn", async () => {
    const r = await api("/api/projects", { method: "POST", json: { name: "test-game", starter: "low-poly-cozy", pitch: "A frog postman delivers letters in a swamp." } });
    expect(r.status).toBe(201);
    await waitFor(async () => (await api("/api/p/test-game/state")).body.chat.history.some((m: { role: string }) => m.role === "assistant"));
    const s = (await api("/api/p/test-game/state")).body;
    expect(s.bible.meta.pitch).toMatch(/frog postman/);
    expect(s.bible.meta.approved).toBe(false);
    expect(s.chat.history.map((m: { role: string }) => m.role)).toEqual(["user", "tool", "assistant"]);
    expect(s.costs.byService.anthropic).toBeCloseTo(0.42);
    expect(loadLedger(join(root, "test-game"))[0]!.service).toBe("anthropic");
    // The director runs with the studio MCP server and resumes its session next time.
    const args = readFileSync(claude.argsFile, "utf8");
    expect(args).toContain("--mcp-config");
    expect(args).toContain("STUDIO_PROJECT_DIR");
    await api("/api/p/test-game/chat", { method: "POST", json: { message: "Make it rain" } });
    await waitFor(async () => readFileSync(claude.argsFile, "utf8").includes("--resume sess-123"));
    await waitFor(async () => !(await api("/api/p/test-game/state")).body.chat.running);
    // The CLI reports the session's running total; a resumed turn with no new spend adds nothing.
    expect(loadLedger(join(root, "test-game")).length).toBe(1);
    expect(s.waiting.some((w: { kind: string }) => w.kind === "bible")).toBe(true);
  });

  it("rejects bad names and duplicate projects", async () => {
    expect((await api("/api/projects", { method: "POST", json: { name: "Bad Name", starter: "dark-fantasy", startDirector: false } })).status).toBe(400);
    await api("/api/projects", { method: "POST", json: { name: "dupe", starter: "dark-fantasy" } });
    expect((await api("/api/projects", { method: "POST", json: { name: "dupe", starter: "dark-fantasy" } })).body.error).toMatch(/already exists/);
  });

  it("validates bible edits, bumps the version, and approves", async () => {
    await api("/api/projects", { method: "POST", json: { name: "edits", starter: "dark-fantasy" } });
    const s = (await api("/api/p/edits/state")).body;
    const lore = s.bible.lore;
    lore.bestiary.rat.hp = 7;
    const ok = await api("/api/p/edits/bible/lore", { method: "PUT", json: lore });
    expect(ok.body.version).toBe(2);
    lore.bestiary.rat.lootTable = "nope";
    const bad = await api("/api/p/edits/bible/lore", { method: "PUT", json: lore });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/unknown loot table/);
    await api("/api/p/edits/bible-approval", { method: "POST", json: { approved: true } });
    expect((await api("/api/p/edits/state")).body.bible.meta.approved).toBe(true);
  });

  it("runs the concept -> approve -> 3D gate and blocks 3D until the bible is approved", async () => {
    await api("/api/projects", { method: "POST", json: { name: "assets", starter: "retro-sci-fi" } });
    const job = (await api("/api/p/assets/concept", { method: "POST", json: { subject: "cargo crate", kind: "prop" } })).body;
    expect(job.status).toBe("running");
    await waitFor(async () => (await api("/api/p/assets/state")).body.assets.length === 1);
    await api("/api/p/assets/approve-concept/cargo-crate", { method: "POST" });
    const blocked = await api("/api/p/assets/make3d/cargo-crate", { method: "POST" });
    expect(blocked.status).toBe(409);
    const img = await fetch(`${base}/files/assets/assets/concepts/cargo-crate.png`);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect((await fetch(`${base}/files/assets/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
  });

  it("imports need a source and license; audio comes out as OGG", async () => {
    await api("/api/projects", { method: "POST", json: { name: "imports", starter: "dark-fantasy" } });
    const wav = readFileSync(new URL("./fixtures/beep.wav", import.meta.url));
    const refused = await api(`/api/p/imports/import?filename=beep.wav&as=sfx`, { method: "POST", body: wav });
    expect(refused.body.error).toMatch(/license/i);
    const q = new URLSearchParams({ filename: "beep.wav", as: "sfx", origin: "in-house", license: "Made by us", tags: "sfx:hit" });
    await api(`/api/p/imports/import?${q}`, { method: "POST", body: wav });
    await waitFor(async () => (await api("/api/p/imports/state")).body.assets.length === 1);
    const a = (await api("/api/p/imports/state")).body.assets[0];
    expect(a.locked).toBe(true);
    expect(a.tags).toContain("sfx:hit");
    expect(a.audio.file).toMatch(/\.ogg$/);
  });

  it("approval decisions come from the user API", async () => {
    await api("/api/projects", { method: "POST", json: { name: "queue", starter: "dark-fantasy" } });
    const { requestApproval } = await import("../src/studio/approvals");
    const req = requestApproval(join(root, "queue"), { step: "concept", service: "openai", usd: 0.07, detail: "x" }, { tool: "generate_concept", args: { subject: "a" } }, "Concept: a");
    const r = await api(`/api/p/queue/approvals/${req.id}`, { method: "POST", json: { approve: true, notifyDirector: false } });
    expect(r.body.status).toBe("approved");
    expect((await api(`/api/p/queue/approvals/${req.id}`, { method: "POST", json: { approve: true } })).body.error).toMatch(/already/);
  });
});
