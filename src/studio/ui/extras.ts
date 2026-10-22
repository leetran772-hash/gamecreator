// Audio, import, re-material and asset-QA UI.
import { h } from "./dom";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const ORIGINS = ["purchased-pack", "commissioned", "royalty-free", "in-house"];
const EVENT_TAGS = ["sfx:attack", "sfx:hit", "sfx:hurt", "sfx:miss", "sfx:pickup", "sfx:defeat", "sfx:descend", "sfx:death", "sfx:victory", "music:explore"];

function dialog(title: string, ...body: Node[]) {
  const d = h("dialog", {}) as HTMLDialogElement;
  d.append(h("form", { method: "dialog" }, h("h2", {}, title), ...body));
  document.body.append(d);
  d.addEventListener("close", () => d.remove());
  d.showModal();
  return d;
}

const label = (text: string, input: Node) => h("label", { style: "display:grid;gap:4px" }, h("span", { class: "muted" }, text), input);

export function extraAssetActions(a: Any, ctx: Any): Node[] {
  const out: Node[] = [];
  if (a.rawModel && !a.locked && a.status === "cleaned")
    out.push(h("button", { title: "Re-run Blender cleanup so materials match the current palette (free)", onclick: () => ctx.act(() => ctx.papi(`rematerial/${a.id}`, { method: "POST" }), "Re-material started") }, "Re-material"));
  return out;
}

export const extraQaButtons: ((ctx: Any) => Node)[] = [
  (ctx) => h("button", { onclick: () => ctx.act(() => ctx.papi("godot", { method: "POST" }), "Exporting the Godot project") }, "Export to Godot"),
  (ctx) => h("button", { title: "Needs Godot on the studio machine", onclick: () => ctx.act(() => ctx.papi("godot-qa", { method: "POST" }), "Godot playtest started") }, "Godot playtest"),
  (ctx) =>
    h(
      "button",
      {
        onclick: async () => {
          try {
            const r = await ctx.papi("asset-qa");
            alert(r.issues.length ? `${r.checked} assets checked:\n\n${r.issues.map((i: Any) => `• ${i.assetId}: ${i.message}`).join("\n")}` : `✅ ${r.checked} assets checked, no problems.`);
          } catch (e) {
            alert((e as Error).message);
          }
        },
      },
      "Asset QA",
    ),
];

export function importDialog(ctx: Any) {
  const file = h("input", { type: "file", required: true }) as HTMLInputElement;
  const as = h("select", {}, h("option", { value: "" }, "Detect from file"), ...["music", "sfx", "model", "texture", "image", "font", "reference"].map((t) => h("option", { value: t }, t))) as HTMLSelectElement;
  const origin = h("select", {}, ...ORIGINS.map((o) => h("option", { value: o }, o.replace("-", " ")))) as HTMLSelectElement;
  const license = h("textarea", { rows: 2, placeholder: "License terms or link (required)" }) as HTMLTextAreaElement;
  const tags = h("input", { placeholder: "boss battle, tavern, sfx:hit" }) as HTMLInputElement;
  const err = h("div", { class: "error" });
  const d = dialog(
    "Import a file",
    h("p", { class: "muted" }, "Music, SFX, 3D models, textures, fonts or reference images. Imports are processed like generated assets (audio → normalized OGG, models → Blender cleanup, images → resized + icons) and locked so the director never regenerates them. Reference images become GPT style references."),
    file,
    label("Type", as),
    label("Source", origin),
    label("License", license),
    label("Bible tags (comma separated)", tags),
    h("div", { class: "muted" }, `Game event tags: ${EVENT_TAGS.join(", ")}`),
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
            const f = file.files?.[0];
            if (!f) return void (err.textContent = "Choose a file.");
            if (!license.value.trim()) return void (err.textContent = "License terms are required.");
            const q = new URLSearchParams({ filename: f.name, origin: origin.value, license: license.value, tags: tags.value, ...(as.value ? { as: as.value } : {}) });
            await ctx.act(() => ctx.papi(`import?${q}`, { method: "POST", body: f }), "Import started — see Tasks");
            d.close();
          },
        },
        "Import",
      ),
    ),
  );
}

export function audioDialog(ctx: Any) {
  const s = ctx.state;
  const approved = s.bible.meta.approved;
  const kind = h("select", {}, h("option", { value: "sfx" }, "Sound effect"), h("option", { value: "music" }, "Music"), h("option", { value: "voice" }, "Voice line")) as HTMLSelectElement;
  const text = h("input", { placeholder: "e.g. bone clatter on stone" }) as HTMLInputElement;
  const mood = h("select", {}, ...Object.keys(s.bible.audio.musicMoods).map((m) => h("option", { value: m }, m))) as HTMLSelectElement;
  const seconds = h("input", { type: "number", value: "60", min: "5", max: "300" }) as HTMLInputElement;
  const character = h("select", {}, ...Object.entries(s.bible.audio.voices).map(([id, v]: [string, Any]) => h("option", { value: id, disabled: !v.voiceId }, `${id}${v.voiceId ? "" : " (no voice ID set)"}`))) as HTMLSelectElement;
  const tags = h("input", { placeholder: "sfx:hit, combat" }) as HTMLInputElement;
  const fields = h("div", { style: "display:grid;gap:8px" });
  const show = () => {
    fields.replaceChildren(
      ...(kind.value === "sfx"
        ? [label("Describe the sound", text), label("Tags", tags)]
        : kind.value === "music"
          ? [label("Mood (from the bible)", mood), label("Length (seconds)", seconds), label("Tags", tags)]
          : [label("Character", character), label("Line", text)]),
    );
  };
  kind.onchange = show;
  show();
  const est = s.estimates;
  const cost = () =>
    kind.value === "music"
      ? Math.max(1, Math.ceil(Number(seconds.value) / 60)) * est.musicPerMinute
      : kind.value === "sfx"
        ? est.sfx.usd
        : (text.value.length / 1000) * est.voicePer1kChars;
  const d = dialog(
    "New audio",
    approved ? h("p", { class: "muted" }, "Generated with ElevenLabs in the bible's audio style, then loudness-normalized to OGG.") : h("p", { class: "error" }, "Approve the bible first (Bible tab)."),
    label("Kind", kind),
    fields,
    h(
      "div",
      { class: "row" },
      h("button", { value: "no" }, "Cancel"),
      h(
        "button",
        {
          class: "primary",
          disabled: !approved,
          onclick: (e: Event) => {
            e.preventDefault();
            d.close();
            const run =
              kind.value === "sfx"
                ? () => ctx.papi("sfx", { method: "POST", json: { description: text.value, tags: tags.value } })
                : kind.value === "music"
                  ? () => ctx.papi("music", { method: "POST", json: { mood: mood.value, seconds: Number(seconds.value), tags: tags.value } })
                  : () => ctx.papi("voices", { method: "POST", json: { lines: [{ characterId: character.value, text: text.value }] } });
            ctx.confirmSpend(`Generate ${kind.selectedOptions[0]!.textContent}`, cost(), run);
          },
        },
        "Continue",
      ),
    ),
  );
}
