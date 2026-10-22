// Branching and undo on the Git-backed project folder.
import { execFileSync } from "node:child_process";
import { relative } from "node:path";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const root = (dir: string) => git(dir, "rev-parse", "--show-toplevel");
const rel = (dir: string) => relative(root(dir), dir) || ".";

export function hasChanges(dir: string): boolean {
  return git(root(dir), "status", "--porcelain", "--", rel(dir)) !== "";
}

/** Commits everything in the project folder. Returns the commit hash, or null when nothing changed. */
export function checkpoint(dir: string, message: string): string | null {
  const r = root(dir);
  const p = rel(dir);
  git(r, "add", "-A", "--", p);
  if (git(r, "diff", "--cached", "--name-only", "--", p) === "") return null;
  git(r, "commit", "-q", "-m", message, "--", p);
  return git(r, "rev-parse", "--short", "HEAD");
}

export interface Commit {
  hash: string;
  date: string;
  message: string;
}

export function history(dir: string, limit = 30): Commit[] {
  const out = git(root(dir), "log", `-${limit}`, "--format=%h%x09%cI%x09%s", "--", rel(dir));
  return out
    ? out.split("\n").map((l) => {
        const [hash, date, ...m] = l.split("\t");
        return { hash: hash!, date: date!, message: m.join("\t") };
      })
    : [];
}

/** Puts the project folder back exactly as it was at `commit` and records that as a new commit (nothing is lost). */
export function restore(dir: string, commit: string): string | null {
  if (!/^[0-9a-f]{4,40}$/.test(commit)) throw new Error(`Bad commit "${commit}"`);
  const r = root(dir);
  const p = rel(dir);
  checkpoint(dir, "Checkpoint before undo");
  git(r, "restore", `--source=${commit}`, "--staged", "--worktree", "--", p);
  git(r, "clean", "-fdq", "--", p);
  return checkpoint(dir, `Undo: restore ${p} to ${commit}`);
}

export function currentBranch(dir: string): string {
  return git(root(dir), "rev-parse", "--abbrev-ref", "HEAD");
}

export function branches(dir: string): string[] {
  return git(root(dir), "branch", "--format=%(refname:short)").split("\n").filter(Boolean);
}

/** "Try a harder version": checkpoint, then continue on a new branch. Switching back returns the old version untouched. */
export function branch(dir: string, name: string): string {
  const safe = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
  if (!safe) throw new Error("Branch name needs letters or digits");
  checkpoint(dir, `Checkpoint before branch ${safe}`);
  const b = `studio/${safe}`;
  git(root(dir), "switch", "-q", "-c", b);
  return b;
}

export function switchBranch(dir: string, name: string): void {
  if (!branches(dir).includes(name)) throw new Error(`No branch ${name}`);
  checkpoint(dir, `Checkpoint before switching to ${name}`);
  git(root(dir), "switch", "-q", name);
}
