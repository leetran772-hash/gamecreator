import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { decide, pendingApprovals } from "../src/studio/approvals";
import { setBibleApproved, writeLayer } from "../src/studio/bible";
import { buildServer } from "../src/studio/mcp";
import { AssetPipeline, dryRunClients } from "../src/pipeline/assetPipeline";

const project = () => {
  const dir = mkdtempSync(join(tmpdir(), "gc-mcp-"));
  cpSync("projects/dungeon-crawler/bible", join(dir, "bible"), { recursive: true });
  cpSync("projects/dungeon-crawler/game.json", join(dir, "game.json"));
  return dir;
};

async function connect(dir: string) {
  const server = buildServer(dir, true);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
  };
  return { client, call };
}

describe("studio MCP tools", () => {
  it("lists the director's tools", async () => {
    const { client } = await connect(project());
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["read_bible", "write_bible", "encyclopedia_index", "generate_concept", "make_3d", "run_qa", "visual_check", "update_task_board", "checkpoint"])
      expect(names).toContain(n);
  });

  it("paid tools wait for the user's approval and then run", async () => {
    const dir = project();
    const { call } = await connect(dir);
    const first = await call("generate_concept", { subject: "crypt rat", kind: "creature" });
    expect(first.text).toMatch(/Needs the user's approval/);
    const [req] = pendingApprovals(dir);
    expect(req!.estimate.usd).toBeGreaterThan(0);
    // Asking again does not create a second request.
    await call("generate_concept", { subject: "crypt rat", kind: "creature" });
    expect(pendingApprovals(dir).length).toBe(1);
    decide(dir, req!.id, true);
    const done = await call("generate_concept", { subject: "crypt rat", kind: "creature" });
    expect(JSON.parse(done.text).ok).toBe(true);
    // The approval is single-use.
    const again = await call("generate_concept", { subject: "crypt rat", kind: "creature", description: "fatter" });
    expect(again.text).toMatch(/Needs the user's approval/);
  });

  it("3D needs an approved bible and an approved concept", async () => {
    const dir = project();
    const meta = JSON.parse(readFileSync(join(dir, "bible/meta.json"), "utf8"));
    meta.approved = false;
    writeLayer(dir, "meta", meta, "user");
    const p = new AssetPipeline(dir, dryRunClients());
    await p.concept("iron chest", { kind: "prop", approved: true });
    const { call } = await connect(dir);
    expect((await call("make_3d", { id: "iron-chest" })).text).toMatch(/not approved the bible/);
    setBibleApproved(dir, true);
    expect((await call("make_3d", { id: "iron-chest" })).text).toMatch(/hasn't approved the concept/);
    p.approve("iron-chest");
    expect((await call("make_3d", { id: "iron-chest" })).text).toMatch(/Needs the user's approval/);
  });

  it("agent bible writes are validated, bump the version, and cannot approve", async () => {
    const dir = project();
    const { call } = await connect(dir);
    const meta = JSON.parse((await call("read_bible", { layer: "meta" })).text);
    setBibleApproved(dir, false);
    const res = await call("write_bible", { layer: "meta", data: { ...meta, title: "New Name", approved: true } });
    expect(JSON.parse(res.text).version).toBe(meta.version + 1);
    const after = JSON.parse(readFileSync(join(dir, "bible/meta.json"), "utf8"));
    expect(after.title).toBe("New Name");
    expect(after.approved).toBe(false);
    const lore = JSON.parse((await call("read_bible", { layer: "lore" })).text);
    lore.bestiary.rat.lootTable = "missing";
    const bad = await call("write_bible", { layer: "lore", data: lore });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/unknown loot table/);
  });

  it("task board and status", async () => {
    const dir = project();
    const { call } = await connect(dir);
    await call("update_task_board", { items: [{ title: "Draft bible", status: "done" }, { title: "Concepts", status: "doing" }] });
    const status = JSON.parse((await call("studio_status")).text);
    expect(status.tasks.plan.length).toBe(2);
    expect(status.dryRun).toBe(true);
  });
});
