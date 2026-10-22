// Task board: what the agent is doing now, its plan, and what waits on the user.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Bible } from "../bible/types";
import { loadRegistry } from "../pipeline/registry";
import { pendingApprovals } from "./approvals";

export interface PlanItem {
  title: string;
  status: "todo" | "doing" | "done" | "blocked";
  note?: string;
}

export interface TaskBoardFile {
  plan: PlanItem[];
  now?: string;
  updatedAt?: string;
}

const file = (dir: string) => join(dir, ".studio", "tasks.json");

export function loadTasks(dir: string): TaskBoardFile {
  const f = file(dir);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as TaskBoardFile) : { plan: [] };
}

export function saveTasks(dir: string, t: TaskBoardFile) {
  mkdirSync(join(dir, ".studio"), { recursive: true });
  writeFileSync(file(dir), JSON.stringify({ ...t, updatedAt: new Date().toISOString() }, null, 2) + "\n");
}

export function setPlan(dir: string, plan: PlanItem[]) {
  saveTasks(dir, { ...loadTasks(dir), plan });
}

export function setNow(dir: string, now: string | undefined) {
  saveTasks(dir, { ...loadTasks(dir), now });
}

/** Everything that is blocked on the user right now. */
export function waitingOnUser(dir: string): { kind: string; id: string; text: string }[] {
  const out: { kind: string; id: string; text: string }[] = [];
  const meta = JSON.parse(readFileSync(join(dir, "bible", "meta.json"), "utf8")) as Bible["meta"];
  if (!meta.approved) out.push({ kind: "bible", id: "bible", text: "Review and approve the bible (needed before any Meshy or ElevenLabs spend)" });
  for (const a of pendingApprovals(dir)) out.push({ kind: "spend", id: a.id, text: `${a.summary} — est. $${a.estimate.usd.toFixed(2)}` });
  for (const a of loadRegistry(dir).assets)
    if (a.status === "concept" && a.concept) out.push({ kind: "concept", id: a.id, text: `Approve or redo the concept for "${a.subject}"` });
  return out;
}
