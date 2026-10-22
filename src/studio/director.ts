// The director: Claude Code running headless inside the project folder, with
// the studio's MCP tools. Each chat message is one `claude -p` turn that
// resumes the project's session; its stream is turned into simple events for
// the studio UI, and its cost goes into the project's ledger.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recordCost } from "./ledger";
import { REPO_ROOT } from "./projects";
import { setNow } from "./tasks";

export type DirectorEvent =
  | { type: "user"; text: string }
  | { type: "delta"; text: string }
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; summary: string }
  | { type: "tool_result"; id: string; ok: boolean; preview: string }
  | { type: "done"; costUsd: number; durationMs?: number }
  | { type: "error"; text: string };

export interface ChatEntry {
  role: "user" | "assistant" | "tool" | "error";
  text: string;
  at: string;
}

export const DIRECTOR_BRIEF = `You are the director of an AI game studio, working inside one project folder.
The project folder is the source of truth: bible/ (one JSON file per layer), game.json (engine-neutral game description), assets.json, assets/.
Studio code (engine-neutral core, engines, pipelines) is in the repository root added to your directories; read its CLAUDE.md.
Use the studio MCP tools for bible reads/writes, the encyclopedia, concepts, 3D, audio, imports, QA and checkpoints.
Rules: read only the bible layer you need; plan from the encyclopedia index; keep the task board updated (update_task_board) so the user sees what you are doing and what is next;
paid tools create approval requests: when one is pending, tell the user what it is and what it costs, then carry on with other work;
never ask to approve the bible yourself: the user approves it in the Bible tab; run run_qa after gameplay changes and visual_check after visual changes (then Read the screenshots and review them against the bible);
save a checkpoint after each meaningful step. Keep replies short: the user reads them in a chat pane next to the game preview.`;

/** Vars that tie a process to the session that launched it; the director gets its own session. */
const SESSION_VARS = /^(CLAUDECODE|CLAUDE_CODE_SESSION_ID|CLAUDE_CODE_REMOTE_SESSION_ID|CLAUDE_CODE_CHILD_SESSION|CLAUDE_CODE_MESSAGING_.*|CLAUDE_CODE_TEE_SDK_STDOUT|CLAUDE_CODE_ENTRYPOINT|CLAUDE_PID)$/;

export interface DirectorOptions {
  claudeBin?: string;
  dryRunTools?: boolean;
  model?: string;
  extraArgs?: string[];
}

export class Director {
  private proc?: ChildProcess;
  private listeners = new Set<(e: DirectorEvent) => void>();

  constructor(
    readonly dir: string,
    readonly opts: DirectorOptions = {},
  ) {}

  get running() {
    return !!this.proc;
  }

  private file(name: string) {
    mkdirSync(join(this.dir, ".studio"), { recursive: true });
    return join(this.dir, ".studio", name);
  }

  private session(): { sessionId?: string; costSoFar?: number } {
    const f = this.file("session.json");
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as { sessionId?: string; costSoFar?: number }) : {};
  }

  get sessionId(): string | undefined {
    return this.session().sessionId;
  }

  private set sessionId(id: string | undefined) {
    const cur = this.session();
    writeFileSync(this.file("session.json"), JSON.stringify({ sessionId: id, costSoFar: cur.sessionId === id ? cur.costSoFar ?? 0 : 0 }) + "\n");
  }

  /**
   * Claude Code reports the session's running total, which carries over on
   * --resume. Returns this turn's share and remembers the new total.
   */
  private turnCost(sessionTotal: number): number {
    const cur = this.session();
    const before = cur.costSoFar ?? 0;
    const turn = sessionTotal >= before ? sessionTotal - before : sessionTotal;
    writeFileSync(this.file("session.json"), JSON.stringify({ ...cur, costSoFar: sessionTotal }) + "\n");
    return turn;
  }

  history(): ChatEntry[] {
    const f = this.file("chat.json");
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as ChatEntry[]) : [];
  }

  private append(role: ChatEntry["role"], text: string) {
    const h = this.history();
    h.push({ role, text, at: new Date().toISOString() });
    writeFileSync(this.file("chat.json"), JSON.stringify(h.slice(-400), null, 2) + "\n");
  }

  on(fn: (e: DirectorEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: DirectorEvent) {
    for (const l of this.listeners) l(e);
  }

  mcpConfig() {
    return {
      mcpServers: {
        studio: {
          command: process.execPath,
          args: [join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(REPO_ROOT, "src", "studio", "mcp.ts")],
          env: { STUDIO_PROJECT_DIR: this.dir, STUDIO_DRY_RUN: this.opts.dryRunTools ? "1" : "0", ...(process.env.BLENDER ? { BLENDER: process.env.BLENDER } : {}) },
        },
      },
    };
  }

  args(message: string): string[] {
    const a = [
      "-p",
      message,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--mcp-config",
      JSON.stringify(this.mcpConfig()),
      "--strict-mcp-config",
      "--append-system-prompt",
      DIRECTOR_BRIEF,
      "--add-dir",
      REPO_ROOT,
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "mcp__studio__*",
      "Read",
      "Edit",
      "Write",
      "Glob",
      "Grep",
      "Bash(npm run *)",
      "Bash(npx tsx *)",
      "Bash(npx vitest *)",
      "Bash(git status*)",
      "Bash(git diff*)",
      "Bash(git log*)",
    ];
    if (this.sessionId) a.push("--resume", this.sessionId);
    if (this.opts.model) a.push("--model", this.opts.model);
    return [...a, ...(this.opts.extraArgs ?? [])];
  }

  /** Runs one director turn. Resolves when the turn ends. */
  send(message: string): Promise<{ costUsd: number }> {
    if (this.proc) return Promise.reject(new Error("The director is still working on the last message."));
    this.append("user", message);
    this.emit({ type: "user", text: message });
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SESSION_VARS.test(k)));
    const proc = spawn(this.opts.claudeBin ?? "claude", this.args(message), { cwd: this.dir, env, stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    let buf = "";
    let stderr = "";
    let costUsd = 0;
    let assistantText = "";
    const tools = new Map<string, string>();

    const handle = (line: string) => {
      let ev: Record<string, any>;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.type === "system" && ev.subtype === "init" && ev.session_id && ev.session_id !== this.sessionId) this.sessionId = ev.session_id;
      if (ev.type === "stream_event" && ev.event?.type === "content_block_delta" && ev.event.delta?.type === "text_delta" && !ev.parent_tool_use_id)
        this.emit({ type: "delta", text: ev.event.delta.text });
      if (ev.type === "assistant" && !ev.parent_tool_use_id) {
        for (const block of ev.message?.content ?? []) {
          if (block.type === "text" && block.text.trim()) {
            assistantText += (assistantText ? "\n\n" : "") + block.text;
            this.emit({ type: "text", text: block.text });
          }
          if (block.type === "tool_use") {
            const summary = summarizeTool(block.name, block.input);
            tools.set(block.id, summary);
            setNow(this.dir, summary);
            this.append("tool", summary);
            this.emit({ type: "tool", id: block.id, name: block.name, summary });
          }
        }
      }
      if (ev.type === "user") {
        for (const block of ev.message?.content ?? []) {
          if (block.type !== "tool_result" || !tools.has(block.tool_use_id)) continue;
          const content = Array.isArray(block.content) ? block.content.map((c: { text?: string }) => c.text ?? "").join("\n") : String(block.content ?? "");
          this.emit({ type: "tool_result", id: block.tool_use_id, ok: !block.is_error, preview: content.slice(0, 400) });
        }
      }
      if (ev.type === "result") {
        if (ev.session_id && ev.session_id !== this.sessionId) this.sessionId = ev.session_id;
        costUsd = this.turnCost(Number(ev.total_cost_usd ?? 0));
        if (ev.is_error && ev.result) this.emit({ type: "error", text: String(ev.result) });
      }
    };

    proc.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        handle(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    proc.stderr!.on("data", (c: Buffer) => (stderr += c.toString()));

    return new Promise((resolve, reject) => {
      const finish = (err?: Error) => {
        this.proc = undefined;
        setNow(this.dir, undefined);
        if (assistantText) this.append("assistant", assistantText);
        if (costUsd > 0) recordCost(this.dir, { service: "anthropic", step: "director turn", usd: costUsd });
        if (err) {
          this.append("error", err.message);
          this.emit({ type: "error", text: err.message });
          reject(err);
        } else {
          this.emit({ type: "done", costUsd });
          resolve({ costUsd });
        }
      };
      proc.on("error", (e) => finish(new Error(`Could not start Claude Code (${e.message}). Is the claude CLI installed and logged in?`)));
      proc.on("close", (code) => {
        if (buf.trim()) handle(buf);
        if (code === 0 || code === null) finish();
        else finish(new Error(`Claude Code exited with code ${code}: ${stderr.slice(-800) || "no output"}`));
      });
    });
  }

  stop() {
    this.proc?.kill("SIGINT");
  }
}

export function summarizeTool(name: string, input: Record<string, unknown> = {}): string {
  const short = name.replace(/^mcp__studio__/, "");
  const pick = input.subject ?? input.layer ?? input.id ?? input.file_path ?? input.command ?? input.pattern ?? input.scene ?? input.message ?? input.description;
  return pick ? `${short}: ${String(pick).slice(0, 80)}` : short;
}
