// Studio UI: chat with the director on the left, the game and production
// tools on the right. Plain DOM, no framework; state comes from /api and is
// refreshed on server-sent events.
import { h, clear, debounce, fmtUsd, timeAgo } from "./dom";
import { jsonEditor } from "./editor";
import { modelViewer } from "./viewer";
import { extraAssetActions, extraQaButtons, importDialog, audioDialog } from "./extras";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const TABS = ["Play", "Bible", "Assets", "Tasks", "Costs", "QA", "History"] as const;
type Tab = (typeof TABS)[number];

const store = {
  projects: [] as { name: string; title: string; approved: boolean }[],
  starters: [] as string[],
  project: localStorageGet("studio.project") ?? "",
  tab: (localStorageGet("studio.tab") as Tab) ?? "Play",
  bibleLayer: "meta",
  state: null as Any,
  streaming: "",
  showChat: false,
  jobLogs: new Map<string, { title: string; status: string; lines: string[] }>(),
  previewKey: 0,
};

function localStorageGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function localStorageSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
}

export async function api(path: string, init: RequestInit & { json?: unknown } = {}) {
  const res = await fetch(path, {
    ...init,
    headers: init.json !== undefined ? { "Content-Type": "application/json" } : init.headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}
const papi = (path: string, init?: RequestInit & { json?: unknown }) => api(`/api/p/${store.project}/${path}`, init);
export const fileUrl = (path?: string) => (path ? `/files/${store.project}/${path}?v=${store.state?.bible?.meta?.version ?? 0}` : "");

function toast(msg: string, bad = false) {
  const t = h("div", { style: `position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:var(--panel);border:1px solid ${bad ? "var(--bad)" : "var(--line)"};padding:8px 14px;border-radius:8px;z-index:9;max-width:90vw` }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 4000);
}
export async function act(fn: () => Promise<unknown>, ok?: string) {
  try {
    await fn();
    if (ok) toast(ok);
    await refresh();
  } catch (e) {
    toast((e as Error).message, true);
  }
}

// ---------- data ----------
let events: EventSource | undefined;
async function loadProjects() {
  const r = await api("/api/projects");
  store.projects = r.projects;
  store.starters = r.starters;
  if (!store.projects.some((p) => p.name === store.project)) store.project = store.projects[0]?.name ?? "";
}

async function refresh() {
  if (!store.project) {
    store.state = null;
    return render();
  }
  store.state = await papi("state");
  render();
}
const refreshSoon = debounce(() => void refresh().catch(() => {}), 250);

function connect() {
  events?.close();
  if (!store.project) return;
  events = new EventSource(`/api/p/${store.project}/events`);
  events.addEventListener("state", () => refreshSoon());
  events.addEventListener("director", (e) => {
    const ev = JSON.parse((e as MessageEvent).data);
    if (ev.type === "delta") {
      store.streaming += ev.text;
      renderStreaming();
      return;
    }
    if (ev.type === "text") store.streaming = "";
    if (ev.type === "done" || ev.type === "error") store.streaming = "";
    refreshSoon();
  });
  events.addEventListener("job", (e) => {
    const ev = JSON.parse((e as MessageEvent).data);
    const j = store.jobLogs.get(ev.id) ?? { title: ev.title, status: ev.status, lines: [] as string[] };
    j.status = ev.status;
    if (ev.line) j.lines.push(ev.line);
    store.jobLogs.set(ev.id, j);
    if (ev.status !== "running") refreshSoon();
    else if (store.tab === "Tasks" || store.tab === "QA") renderPanelSoon();
  });
}
const renderPanelSoon = debounce(() => renderContent(), 200);

async function selectProject(name: string) {
  store.project = name;
  localStorageSet("studio.project", name);
  store.jobLogs.clear();
  connect();
  await refresh();
}

// ---------- layout ----------
const root = document.getElementById("studio")!;
let contentEl: HTMLElement;
let messagesEl: HTMLElement;
let streamingEl: HTMLElement | undefined;

function render() {
  const s = store.state;
  const pending = s?.approvals?.filter((a: Any) => a.status === "pending").length ?? 0;
  clear(root);
  root.append(
    h(
      "header",
      {},
      h("span", { class: "brand" }, "🎮 Studio"),
      h(
        "select",
        { onchange: (e: Event) => void selectProject((e.target as HTMLSelectElement).value), "aria-label": "Project" },
        ...store.projects.map((p) => h("option", { value: p.name, selected: p.name === store.project }, `${p.title} (${p.name})`)),
      ),
      h("button", { onclick: () => newProjectDialog() }, "+ New game"),
      h("span", { class: "spacer" }),
      s ? h("span", { class: "muted" }, `bible v${s.bible.meta.version}`, " ", s.bible.meta.approved ? h("span", { class: "chip good" }, "approved") : h("span", { class: "chip warn" }, "not approved")) : "",
      s?.git ? h("span", { class: "chip" }, `⎇ ${s.git.branch}`) : "",
      s ? h("span", { class: "muted" }, `spend ${fmtUsd(s.costs.total)}`) : "",
      s ? h("button", { onclick: () => approvalsDialog() }, "Approvals", pending ? h("span", { class: "badge" }, String(pending)) : "") : "",
      s?.dryRunTools ? h("span", { class: "chip warn", title: "Paid tools use placeholders" }, "dry run") : "",
    ),
  );
  if (!s) {
    root.append(h("div", { class: "content" }, h("p", {}, "No projects yet. "), h("button", { class: "primary", onclick: () => newProjectDialog() }, "Start a new game")));
    return;
  }
  contentEl = h("div", { class: `content ${store.tab === "Play" ? "play" : ""}` });
  const layout = h(
    "div",
    { class: `layout ${store.showChat ? "show-chat" : ""}` },
    chatPane(),
    h(
      "div",
      { class: "panel" },
      h(
        "nav",
        { class: "tabs" },
        h("button", { class: `tab-chat ${store.showChat ? "active" : ""}`, onclick: () => ((store.showChat = true), render()) }, "Chat"),
        ...TABS.map((t) =>
          h(
            "button",
            {
              class: !store.showChat && store.tab === t ? "active" : "",
              onclick: () => {
                store.tab = t;
                store.showChat = false;
                localStorageSet("studio.tab", t);
                render();
              },
            },
            t,
            t === "Tasks" && s.waiting.length ? h("span", { class: "badge" }, String(s.waiting.length)) : "",
          ),
        ),
      ),
      contentEl,
    ),
  );
  root.append(layout);
  renderContent();
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderContent() {
  if (!contentEl || !store.state) return;
  const scroll = contentEl.scrollTop;
  clear(contentEl);
  contentEl.className = `content ${store.tab === "Play" ? "play" : ""}`;
  const views: Record<Tab, () => Node> = { Play: playView, Bible: bibleView, Assets: assetsView, Tasks: tasksView, Costs: costsView, QA: qaView, History: historyView };
  contentEl.append(views[store.tab]());
  contentEl.scrollTop = scroll;
}

// ---------- chat ----------
function chatPane() {
  const s = store.state;
  const input = h("textarea", {
    placeholder: s.chat.running ? "The director is working…" : "Tell the director what to make or change…",
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendChat();
    },
  }) as HTMLTextAreaElement;
  const sendChat = () => {
    const message = input.value.trim();
    if (!message) return;
    input.value = "";
    void act(() => papi("chat", { method: "POST", json: { message } }));
  };
  messagesEl = h(
    "div",
    { class: "messages", "aria-live": "polite" },
    ...s.chat.history.map((m: Any) => {
      const el = h("div", { class: `msg ${m.role}` });
      if (m.role === "assistant") el.innerHTML = lightMarkdown(m.text);
      else el.textContent = m.text;
      return el;
    }),
  );
  streamingEl = h("div", { class: "msg assistant", style: store.streaming ? "" : "display:none" }, store.streaming);
  messagesEl.append(streamingEl);
  if (!s.chat.history.length)
    messagesEl.append(
      h("div", { class: "muted" }, "Ask for a game, a change, or a check. E.g. “Make the wraith scarier and add a boss on floor 5”, or “Run QA and tell me what's broken”."),
    );
  return h(
    "div",
    { class: "chat" },
    h("div", { class: "now" }, s.chat.running ? `● Working${s.tasks.now ? `: ${s.tasks.now}` : "…"}` : s.waiting.length ? `Waiting on you: ${s.waiting.length} item(s) — see Tasks` : "Idle"),
    messagesEl,
    h(
      "div",
      { class: "composer" },
      input,
      h(
        "div",
        { class: "row" },
        h("span", { class: "muted grow" }, "⌘/Ctrl+Enter to send"),
        s.chat.running ? h("button", { onclick: () => act(() => papi("chat-stop", { method: "POST" })) }, "Stop") : "",
        h("button", { class: "primary", onclick: sendChat, disabled: s.chat.running }, "Send"),
      ),
    ),
  );
}

/** Escapes HTML, then renders **bold**, `code` and [links](url) in director replies. */
function lightMarkdown(text: string) {
  const esc = text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return esc
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function renderStreaming() {
  if (!streamingEl) return;
  streamingEl.textContent = store.streaming;
  streamingEl.style.display = store.streaming ? "" : "none";
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---------- play ----------
function playView() {
  const url = `/game?project=${store.project}`;
  const seed = h("input", { placeholder: "seed (optional)", style: "width:140px" }) as HTMLInputElement;
  const frame = h("iframe", { src: url, title: "Game preview", allow: "autoplay", key: String(store.previewKey) }) as HTMLIFrameElement;
  return h(
    "div",
    { style: "display:contents" },
    h(
      "div",
      { class: "bar row" },
      h("button", { onclick: () => (frame.src = `${url}${seed.value ? `&seed=${encodeURIComponent(seed.value)}` : ""}`) }, "↻ Restart"),
      seed,
      h("a", { href: url, target: "_blank" }, "Open in new tab"),
      h("span", { class: "muted grow" }, "Click the game to focus it. Bible edits reload it automatically."),
    ),
    frame,
  );
}

// ---------- bible ----------
function bibleView() {
  const s = store.state;
  const layer = store.bibleLayer;
  let draft = structuredClone(s.bible[layer]);
  const errors = h("div", { class: "error" });
  const raw = h("textarea", { rows: 24, style: "display:none;font-family:ui-monospace,monospace;font-size:12px" }) as HTMLTextAreaElement;
  const form = jsonEditor(draft, (v) => (draft = v), { readOnlyKeys: layer === "meta" ? ["version", "approved"] : [], fileUrl });
  let rawMode = false;
  const save = () =>
    act(async () => {
      errors.textContent = "";
      const data = rawMode ? JSON.parse(raw.value) : draft;
      try {
        await papi(`bible/${layer}`, { method: "PUT", json: data });
      } catch (e) {
        errors.textContent = (e as Error).message;
        throw e;
      }
    }, "Bible saved");
  return h(
    "div",
    {},
    h(
      "div",
      { class: "item row" },
      h("div", { class: "grow" }, h("b", {}, s.bible.meta.title), " ", h("span", { class: "muted" }, `· v${s.bible.meta.version}`), h("div", { class: "muted" }, s.bible.meta.pitch)),
      s.bible.meta.approved
        ? h("button", { onclick: () => act(() => papi("bible-approval", { method: "POST", json: { approved: false } }), "Bible unlocked for changes") }, "Un-approve")
        : h("button", { class: "primary", onclick: () => act(() => papi("bible-approval", { method: "POST", json: { approved: true } }), "Bible approved") }, "Approve bible"),
    ),
    s.problems.length ? h("div", { class: "error" }, `Problems:\n- ${s.problems.join("\n- ")}`) : "",
    h(
      "nav",
      { class: "tabs", style: "margin:10px 0" },
      ...["meta", "visual", "audio", "lore", "code"].map((l) =>
        h("button", { class: l === layer ? "active" : "", onclick: () => ((store.bibleLayer = l), renderContent()) }, { meta: "Overview", visual: "Visual", audio: "Audio", lore: "Lore & design", code: "Code conventions" }[l]!),
      ),
    ),
    layer === "visual" ? h("div", { class: "swatches", style: "margin-bottom:10px" }, ...Object.entries(s.bible.visual.palette).map(([k, v]) => h("div", { class: "swatch", title: k, style: `background:${v}` }))) : "",
    layer === "visual" && s.bible.visual.concepts.length
      ? h(
          "div",
          { class: "shots", style: "margin-bottom:12px" },
          ...s.bible.visual.concepts.map((c: Any) => h("figure", { style: "margin:0" }, h("img", { src: fileUrl(c.image), alt: c.subject ?? c.id }), h("figcaption", { class: "muted" }, `${c.kind}: ${c.subject ?? c.id}`))),
        )
      : "",
    form,
    raw,
    errors,
    h(
      "div",
      { class: "row", style: "margin-top:12px;position:sticky;bottom:0;background:var(--bg);padding:8px 0" },
      h("button", { class: "primary", onclick: save }, "Save layer"),
      h(
        "button",
        {
          onclick: (e: Event) => {
            rawMode = !rawMode;
            raw.value = JSON.stringify(draft, null, 2);
            raw.style.display = rawMode ? "" : "none";
            form.style.display = rawMode ? "none" : "";
            (e.target as HTMLButtonElement).textContent = rawMode ? "Form view" : "Raw JSON";
          },
        },
        "Raw JSON",
      ),
      h("button", { onclick: () => renderContent() }, "Discard changes"),
      h("span", { class: "muted" }, "Saving bumps the bible version; assets built on older versions are marked stale."),
    ),
  );
}

// ---------- assets ----------
function entityOptions() {
  const lore = store.state.bible.lore;
  return [
    ["player", `Player (${lore.player.name})`],
    ...Object.values(lore.bestiary).map((e: Any) => [e.id, `Enemy: ${e.name}`]),
    ...Object.values(lore.items).map((i: Any) => [i.id, `Item: ${i.name}`]),
  ];
}

function usedBy(model?: string) {
  if (!model) return [];
  const lore = store.state.bible.lore;
  const out: string[] = [];
  if (lore.player.model === model) out.push("player");
  for (const e of Object.values(lore.bestiary) as Any[]) if (e.model === model) out.push(e.name);
  for (const i of Object.values(lore.items) as Any[]) if (i.model === model) out.push(i.name);
  return out;
}

function assetsView() {
  const s = store.state;
  const est = s.estimates;
  const card = (a: Any) => {
    const spend = a.costs.reduce((t: number, c: Any) => t + c.usd, 0);
    const stale = s.stale.includes(a.id);
    const thumb = a.thumbnail ?? a.concept ?? a.files?.thumbnail;
    const actions: Node[] = [];
    if (a.status === "concept" && a.concept && !a.locked) {
      actions.push(h("button", { class: "primary", onclick: () => act(() => papi(`approve-concept/${a.id}`, { method: "POST" }), "Look approved") }, "Approve look"));
      actions.push(h("button", { onclick: () => confirmSpend(`Redo concept for "${a.subject}"`, est.concept.usd, () => papi("concept", { method: "POST", json: { subject: a.subject, kind: a.kind, description: a.description, force: true } })) }, "Redo"));
    }
    if (a.status === "approved" && a.concept && !a.locked)
      actions.push(h("button", { class: "primary", onclick: () => confirmSpend(`Make a 3D model of "${a.subject}" with Meshy`, est.meshy.usd, () => papi(`make3d/${a.id}`, { method: "POST" })) }, `Make 3D (~${fmtUsd(est.meshy.usd)})`));
    if (a.status === "3d") actions.push(h("button", { onclick: () => act(() => papi(`cleanup/${a.id}`, { method: "POST" })) }, "Blender cleanup"));
    if (a.model) {
      actions.push(h("button", { onclick: () => viewModel(a) }, "View 3D"));
      const sel = h(
        "select",
        {
          onchange: (e: Event) => {
            const entity = (e.target as HTMLSelectElement).value;
            if (entity) void act(() => papi("entity-model", { method: "POST", json: { entity, assetId: a.id } }), "Model swapped in the game");
          },
        },
        h("option", { value: "" }, "Use for…"),
        ...entityOptions().map(([v, l]) => h("option", { value: v }, l)),
      );
      actions.push(sel);
    }
    actions.push(...extraAssetActions(a, { papi, act, confirmSpend }));
    return h(
      "div",
      { class: "card" },
      h("div", { class: "thumb" }, thumb ? h("img", { src: fileUrl(thumb), alt: a.subject, loading: "lazy" }) : a.audio ? "🔊" : "◇"),
      h(
        "div",
        { class: "body" },
        h("div", { class: "row" }, h("b", { class: "grow" }, a.subject), h("span", { class: `chip ${a.status === "cleaned" || a.status === "in-game" ? "good" : a.status === "concept" ? "warn" : ""}` }, a.status)),
        h(
          "div",
          { class: "muted" },
          `${a.kind} · ${a.source}${a.locked ? " · 🔒 locked" : ""} · bible v${a.bibleVersion}`,
          stale ? h("span", { class: "chip warn", style: "margin-left:4px" }, "stale") : "",
        ),
        a.license ? h("div", { class: "muted" }, `License: ${a.license.origin} — ${a.license.terms}`) : "",
        a.tags?.length ? h("div", {}, ...a.tags.map((t: string) => h("span", { class: "chip", style: "margin-right:4px" }, t))) : "",
        a.stats ? h("div", { class: "muted" }, `${a.stats.triangles} tris · LODs ${a.stats.lods.join("/")} · ${a.stats.height} m`) : "",
        usedBy(a.model).length ? h("div", { class: "muted" }, `In game: ${usedBy(a.model).join(", ")}`) : "",
        a.audio ? h("audio", { controls: true, src: fileUrl(a.audio.file), style: "width:100%" }) : "",
        h("div", { class: "muted" }, `Spend ${fmtUsd(spend)}`),
        h("div", { class: "actions" }, ...actions),
      ),
    );
  };
  const order = ["concept", "approved", "3d", "cleaned", "in-game"];
  const assets = [...s.assets].sort((x: Any, y: Any) => order.indexOf(x.status) - order.indexOf(y.status));
  return h(
    "div",
    {},
    h(
      "div",
      { class: "row", style: "margin-bottom:12px" },
      h("button", { class: "primary", onclick: () => conceptDialog() }, "+ Concept art"),
      importDialog ? h("button", { onclick: () => importDialog!({ papi, act }) }, "Import file") : "",
      audioDialog ? h("button", { onclick: () => audioDialog!({ papi, act, confirmSpend, state: s }) }, "+ Audio") : "",
      h("span", { class: "muted grow" }, `${assets.length} assets · concept → approve look → Meshy 3D → Blender cleanup → use in game`),
    ),
    assets.length ? h("div", { class: "cards" }, ...assets.map(card)) : h("p", { class: "muted" }, "No assets yet. Ask the director for concept art, or add one here."),
  );
}

function confirmSpend(what: string, usd: number, run: () => Promise<unknown>) {
  const d = h("dialog", {}) as HTMLDialogElement;
  d.append(
    h(
      "form",
      { method: "dialog" },
      h("h2", {}, "Approve spend?"),
      h("p", {}, what),
      h("p", {}, "Estimated cost: ", h("b", {}, fmtUsd(usd)), store.state.dryRunTools ? h("span", { class: "chip warn", style: "margin-left:6px" }, "dry run: $0") : ""),
      h(
        "div",
        { class: "row" },
        h("button", { value: "no" }, "Cancel"),
        h(
          "button",
          {
            class: "primary",
            value: "yes",
            onclick: () => void act(run, "Started — see Tasks for progress"),
          },
          "Approve",
        ),
      ),
    ),
  );
  document.body.append(d);
  d.addEventListener("close", () => d.remove());
  d.showModal();
}

function conceptDialog() {
  const subject = h("input", { required: true, placeholder: "e.g. wooden crate" }) as HTMLInputElement;
  const kind = h("select", {}, ...["character", "creature", "prop", "environment"].map((k) => h("option", { value: k }, k))) as HTMLSelectElement;
  const desc = h("textarea", { rows: 3, placeholder: "Details (optional)" }) as HTMLTextAreaElement;
  const d = h("dialog", {}) as HTMLDialogElement;
  d.append(
    h(
      "form",
      { method: "dialog" },
      h("h2", {}, "New concept art"),
      h("p", { class: "muted" }, "Uses the Meshy-friendly template and the bible's style. Once you approve the look, this exact image becomes Meshy's input."),
      subject,
      kind,
      desc,
      h(
        "div",
        { class: "row" },
        h("button", { value: "no" }, "Cancel"),
        h(
          "button",
          {
            class: "primary",
            value: "yes",
            onclick: (e: Event) => {
              if (!subject.value.trim()) return e.preventDefault();
              void act(() => papi("concept", { method: "POST", json: { subject: subject.value, kind: kind.value, description: desc.value } }), "Generating — see Tasks");
            },
          },
          `Generate (~${fmtUsd(store.state.estimates.concept.usd)})`,
        ),
      ),
    ),
  );
  document.body.append(d);
  d.addEventListener("close", () => d.remove());
  d.showModal();
}

function viewModel(a: Any) {
  const d = h("dialog", {}) as HTMLDialogElement;
  const holder = h("div", { class: "viewer" });
  d.append(h("form", { method: "dialog" }, h("h2", {}, a.subject), holder, h("div", { class: "row" }, h("span", { class: "muted grow" }, "Drag to orbit"), h("button", {}, "Close"))));
  document.body.append(d);
  d.showModal();
  const dispose = modelViewer(holder, fileUrl(a.model), store.state.bible.visual.palette);
  d.addEventListener("close", () => (dispose(), d.remove()));
}

// ---------- approvals ----------
function approvalsDialog() {
  const s = store.state;
  const pending = s.approvals.filter((a: Any) => a.status === "pending");
  const d = h("dialog", {}) as HTMLDialogElement;
  const decide = (id: string, approve: boolean) => act(() => papi(`approvals/${id}`, { method: "POST", json: { approve } }), approve ? "Approved — the director will run it" : "Rejected").then(() => d.close());
  d.append(
    h(
      "form",
      { method: "dialog" },
      h("h2", {}, "Approval queue"),
      h("p", { class: "muted" }, "The director asks before anything that costs money. Nothing below runs until you approve it."),
      pending.length
        ? h(
            "div",
            { class: "list" },
            ...pending.map((a: Any) =>
              h(
                "div",
                { class: "item" },
                h("div", { class: "row" }, h("b", { class: "grow" }, a.summary), h("span", {}, `~${fmtUsd(a.estimate.usd)}`), a.estimate.credits ? h("span", { class: "muted" }, `${a.estimate.credits} credits`) : ""),
                h("div", { class: "muted" }, `${a.estimate.service} · ${a.estimate.detail} · ${timeAgo(a.createdAt)}`),
                h("div", { class: "row", style: "margin-top:6px" }, h("button", { type: "button", class: "primary", onclick: () => decide(a.id, true) }, "Approve"), h("button", { type: "button", class: "danger", onclick: () => decide(a.id, false) }, "Reject")),
              ),
            ),
          )
        : h("p", {}, "Nothing waiting."),
      h("h3", {}, "Recent"),
      h(
        "div",
        { class: "list" },
        ...s.approvals
          .filter((a: Any) => a.status !== "pending")
          .slice(-8)
          .reverse()
          .map((a: Any) => h("div", { class: "muted" }, `${a.status} · ${a.summary} · ${fmtUsd(a.estimate.usd)}`)),
      ),
      h("div", { class: "row" }, h("button", {}, "Close")),
    ),
  );
  document.body.append(d);
  d.addEventListener("close", () => d.remove());
  d.showModal();
}

// ---------- tasks ----------
function jobList(filter?: (title: string) => boolean) {
  const jobs = [...store.jobLogs.entries()].filter(([, j]) => !filter || filter(j.title)).reverse();
  if (!jobs.length) return h("p", { class: "muted" }, "No jobs this session.");
  return h(
    "div",
    { class: "list" },
    ...jobs.map(([id, j]) =>
      h("details", { class: "item", open: j.status === "running" }, h("summary", {}, `${j.status === "running" ? "⏳" : j.status === "done" ? "✅" : "❌"} ${j.title}`), h("pre", { class: "log" }, j.lines.join("\n") || "…"), h("span", { class: "muted" }, id)),
    ),
  );
}

function tasksView() {
  const s = store.state;
  const icon = { todo: "○", doing: "◐", done: "●", blocked: "⚠" } as Record<string, string>;
  return h(
    "div",
    {},
    h("h2", {}, "Doing now"),
    h("div", { class: "item" }, s.chat.running ? `● ${s.tasks.now ?? "Thinking…"}` : "The director is idle."),
    h("h2", {}, "Waiting on you"),
    s.waiting.length
      ? h(
          "div",
          { class: "list" },
          ...s.waiting.map((w: Any) =>
            h(
              "div",
              { class: "item row" },
              h("span", { class: "grow" }, w.text),
              w.kind === "spend" ? h("button", { onclick: () => approvalsDialog() }, "Review") : "",
              w.kind === "bible" ? h("button", { onclick: () => ((store.tab = "Bible"), render()) }, "Open bible") : "",
              w.kind === "concept" ? h("button", { onclick: () => ((store.tab = "Assets"), render()) }, "Open assets") : "",
            ),
          ),
        )
      : h("p", { class: "muted" }, "Nothing — you're all caught up."),
    h("h2", {}, "Director's plan"),
    s.tasks.plan.length
      ? h("div", { class: "list" }, ...s.tasks.plan.map((t: Any) => h("div", { class: "item" }, `${icon[t.status] ?? "○"} ${t.title}`, t.note ? h("div", { class: "muted" }, t.note) : "")))
      : h("p", { class: "muted" }, "No plan posted yet."),
    h("h2", {}, "Jobs"),
    jobList(),
  );
}

// ---------- costs ----------
function costsView() {
  const s = store.state;
  const by = s.costs.byService as Record<string, number>;
  const max = Math.max(0.01, ...Object.values(by));
  const rows: Any[] = [
    ...s.assets.flatMap((a: Any) => a.costs.map((c: Any) => ({ ...c, what: a.subject }))),
    ...s.costs.ledger.map((c: Any) => ({ ...c, what: c.step })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));
  return h(
    "div",
    {},
    h("h2", {}, `Total ${fmtUsd(s.costs.total)}`),
    h("p", { class: "muted" }, "Asset spend uses the estimates shown at approval time; Anthropic spend is what Claude Code reports per director turn."),
    h(
      "table",
      {},
      ...Object.entries(by).map(([svc, usd]) =>
        h("tr", {}, h("td", { style: "width:120px" }, svc), h("td", {}, h("div", { class: "bar-track" }, h("div", { class: "bar-fill", style: `width:${(usd / max) * 100}%` }))), h("td", { style: "width:80px;text-align:right" }, fmtUsd(usd))),
      ),
    ),
    h("h2", {}, "Ledger"),
    rows.length
      ? h("table", {}, h("tr", {}, h("th", {}, "When"), h("th", {}, "Service"), h("th", {}, "What"), h("th", {}, "Cost")), ...rows.slice(0, 200).map((r) => h("tr", {}, h("td", {}, timeAgo(r.at)), h("td", {}, r.service), h("td", {}, `${r.step} · ${r.what}`), h("td", {}, fmtUsd(r.usd)))))
      : h("p", { class: "muted" }, "No spend yet."),
  );
}

// ---------- QA ----------
function qaView() {
  const s = store.state;
  return h(
    "div",
    {},
    h("p", { class: "muted" }, "Checks run before any human playtest: bible validation, balance simulation, bot playtests (crashes, softlocks, unreachable areas), and a headless-browser visual check with screenshots and performance budgets."),
    h(
      "div",
      { class: "row" },
      h("button", { class: "primary", onclick: () => act(() => papi("qa", { method: "POST" }), "QA started") }, "Run QA"),
      h("button", { onclick: () => act(() => papi("visual", { method: "POST" }), "Visual check started") }, "Visual check"),
      h("button", { onclick: () => act(() => papi("chat", { method: "POST", json: { message: "Run run_qa and visual_check, review the screenshots against the bible, and fix anything broken." } })) }, "Ask director to review"),
      ...extraQaButtons.map((f) => f({ papi, act })),
    ),
    s.problems.length ? h("div", { class: "error" }, `Bible problems:\n- ${s.problems.join("\n- ")}`) : h("p", {}, "✅ Bible is valid."),
    h("h2", {}, "Runs"),
    jobList((t) => /QA|Visual|check/i.test(t)),
    s.screenshots?.length ? h("h2", {}, "Latest screenshots") : "",
    s.screenshots?.length ? h("div", { class: "shots" }, ...s.screenshots.map((p: string) => h("a", { href: fileUrl(p), target: "_blank" }, h("img", { src: fileUrl(p), alt: p })))) : "",
  );
}

// ---------- history ----------
function historyView() {
  const s = store.state;
  if (!s.git) return h("p", { class: "muted" }, "This project folder is not in a Git repository, so undo and branching are off.");
  const msg = h("input", { placeholder: "What changed?", class: "grow" }) as HTMLInputElement;
  const variant = h("input", { placeholder: "e.g. harder-version", class: "grow" }) as HTMLInputElement;
  return h(
    "div",
    {},
    h("h2", {}, "Save a checkpoint"),
    h("div", { class: "row" }, msg, h("button", { class: "primary", onclick: () => act(() => papi("git/checkpoint", { method: "POST", json: { message: msg.value || "Checkpoint" } }), "Checkpoint saved") }, "Save")),
    h("h2", {}, "Try a variant"),
    h("p", { class: "muted" }, `Current branch: ${s.git.branch}. A variant is a new branch: experiment freely, then switch back to the old version untouched.`),
    h("div", { class: "row" }, variant, h("button", { onclick: () => act(() => papi("git/branch", { method: "POST", json: { name: variant.value } }), "Switched to the new variant") }, "Create variant")),
    h(
      "div",
      { class: "row", style: "margin-top:6px" },
      h("span", { class: "muted" }, "Switch to:"),
      ...s.git.branches.filter((b: string) => b !== s.git.branch).map((b: string) => h("button", { onclick: () => act(() => papi("git/switch", { method: "POST", json: { name: b } }), `Switched to ${b}`) }, b)),
    ),
    h("h2", {}, "History"),
    h(
      "div",
      { class: "list" },
      ...s.git.history.map((c: Any, i: number) =>
        h(
          "div",
          { class: "item row" },
          h("code", {}, c.hash),
          h("span", { class: "grow" }, c.message),
          h("span", { class: "muted" }, timeAgo(c.date)),
          i > 0 ? h("button", { onclick: () => confirm(`Restore the project to ${c.hash}? The current state is saved first, so this can be undone too.`) && act(() => papi("git/restore", { method: "POST", json: { commit: c.hash } }), "Restored") }, "Restore") : "",
        ),
      ),
    ),
  );
}

// ---------- new project ----------
function newProjectDialog() {
  const name = h("input", { required: true, placeholder: "my-game (lowercase, dashes)", pattern: "[a-z0-9][a-z0-9-]*" }) as HTMLInputElement;
  const starter = h("select", {}, ...store.starters.map((s) => h("option", { value: s }, s.replace(/-/g, " ")))) as HTMLSelectElement;
  const pitch = h("textarea", { rows: 4, placeholder: "Your pitch: what's the game? Who do you play? What's the vibe?" }) as HTMLTextAreaElement;
  const err = h("div", { class: "error" });
  const d = h("dialog", {}) as HTMLDialogElement;
  d.append(
    h(
      "form",
      { method: "dialog" },
      h("h2", {}, "New game"),
      h("p", { class: "muted" }, "Pick a starter bible and pitch your game. The director drafts the bible and a few cheap concepts; you review and approve before any 3D or audio spend."),
      name,
      starter,
      pitch,
      err,
      h(
        "div",
        { class: "row" },
        h("button", { value: "no" }, "Cancel"),
        h(
          "button",
          {
            class: "primary",
            onclick: async (e: Event) => {
              e.preventDefault();
              try {
                await api("/api/projects", { method: "POST", json: { name: name.value.trim(), starter: starter.value, pitch: pitch.value.trim() } });
                d.close();
                await loadProjects();
                store.tab = "Bible";
                await selectProject(name.value.trim());
              } catch (x) {
                err.textContent = (x as Error).message;
              }
            },
          },
          "Create",
        ),
      ),
    ),
  );
  document.body.append(d);
  d.addEventListener("close", () => d.remove());
  d.showModal();
}

// ---------- boot ----------
await loadProjects();
connect();
await refresh();
