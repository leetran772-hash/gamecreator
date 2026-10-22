// Approval queue. Paid steps requested by the agent (through MCP tools) wait
// here with a cost estimate until the user approves them in the studio UI or
// the CLI. The agent can request but never approve.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Estimate } from "../pipeline/gates";

export interface ApprovalRequest {
  id: string;
  createdAt: string;
  status: "pending" | "approved" | "rejected" | "used";
  estimate: Estimate;
  /** What will run once approved, e.g. { tool: "to3d", args: { id: "crypt-rat" } }. */
  action: { tool: string; args: Record<string, unknown> };
  summary: string;
  decidedAt?: string;
}

const file = (projectDir: string) => join(projectDir, "approvals.json");

export function loadApprovals(projectDir: string): ApprovalRequest[] {
  const f = file(projectDir);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as ApprovalRequest[]) : [];
}

function save(projectDir: string, list: ApprovalRequest[]) {
  writeFileSync(file(projectDir), JSON.stringify(list, null, 2) + "\n");
}

const sameAction = (a: ApprovalRequest["action"], b: ApprovalRequest["action"]) =>
  a.tool === b.tool && JSON.stringify(a.args) === JSON.stringify(b.args);

/** Adds a pending request, or returns the existing open one for the same action. */
export function requestApproval(projectDir: string, estimate: Estimate, action: ApprovalRequest["action"], summary: string): ApprovalRequest {
  const list = loadApprovals(projectDir);
  const open = list.find((r) => (r.status === "pending" || r.status === "approved") && sameAction(r.action, action));
  if (open) return open;
  const req: ApprovalRequest = {
    id: `ap-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`,
    createdAt: new Date().toISOString(),
    status: "pending",
    estimate,
    action,
    summary,
  };
  list.push(req);
  save(projectDir, list);
  return req;
}

/** Called by the user (UI or CLI), never by the agent. */
export function decide(projectDir: string, id: string, approve: boolean): ApprovalRequest {
  const list = loadApprovals(projectDir);
  const req = list.find((r) => r.id === id);
  if (!req) throw new Error(`No approval request ${id}`);
  if (req.status !== "pending") throw new Error(`${id} is already ${req.status}`);
  req.status = approve ? "approved" : "rejected";
  req.decidedAt = new Date().toISOString();
  save(projectDir, list);
  return req;
}

/** If an approved request exists for this action, marks it used and returns true. */
export function consumeApproval(projectDir: string, action: ApprovalRequest["action"]): boolean {
  const list = loadApprovals(projectDir);
  const req = list.find((r) => r.status === "approved" && sameAction(r.action, action));
  if (!req) return false;
  req.status = "used";
  save(projectDir, list);
  return true;
}

export const pendingApprovals = (projectDir: string) => loadApprovals(projectDir).filter((r) => r.status === "pending");
