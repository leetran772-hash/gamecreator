// Generic form editor for bible layers: strings, numbers, booleans, colors,
// nested objects and lists. Changes are reported as a fresh copy of the value.
import { h } from "./dom";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const HEX = /^#[0-9a-f]{6}$/i;
const LONG_KEYS = /pitch|description|notes|style|tone|entityStructure|saves|text/i;

export function jsonEditor(
  value: unknown,
  onChange: (v: any) => void, // eslint-disable-line @typescript-eslint/no-explicit-any
  opts: { readOnlyKeys?: string[]; fileUrl?: (p: string) => string } = {},
): HTMLElement {
  const root = structuredClone(value) as Json;
  const changed = () => onChange(structuredClone(root));
  return node(root, changed, opts, 0) as HTMLElement;
}

function node(v: Json, changed: () => void, opts: { readOnlyKeys?: string[] }, depth: number): HTMLElement {
  const box = h("div", { class: "editor" });
  if (Array.isArray(v)) {
    v.forEach((item, i) => box.append(field(String(i + 1), v, i, changed, opts, depth, () => (v.splice(i, 1), changed(), box.replaceWith(node(v, changed, opts, depth))))));
    box.append(
      h(
        "div",
        {},
        h(
          "button",
          {
            type: "button",
            onclick: () => {
              const last = v[v.length - 1];
              v.push(last === undefined ? "" : blank(last));
              changed();
              box.replaceWith(node(v, changed, opts, depth));
            },
          },
          "+ Add",
        ),
      ),
    );
    return box;
  }
  if (v && typeof v === "object") {
    for (const k of Object.keys(v)) box.append(field(k, v, k, changed, opts, depth));
    if (depth > 0 && Object.values(v).every((x) => x && typeof x === "object" && !Array.isArray(x)) && Object.keys(v).length) {
      // A record of objects (bestiary, items, materials...): allow adding by copying the first entry.
      box.append(
        h(
          "div",
          {},
          h(
            "button",
            {
              type: "button",
              onclick: () => {
                const id = prompt("New id (letters, digits)")?.trim();
                if (!id || id in v) return;
                const copy = blank(Object.values(v)[0]!) as { [k: string]: Json };
                if ("id" in copy) copy.id = id;
                v[id] = copy;
                changed();
                box.replaceWith(node(v, changed, opts, depth));
              },
            },
            "+ Add entry",
          ),
        ),
      );
    }
  }
  return box;
}

function field(
  label: string,
  parent: Json[] | { [k: string]: Json },
  key: string | number,
  changed: () => void,
  opts: { readOnlyKeys?: string[] },
  depth: number,
  remove?: () => void,
): HTMLElement {
  const v = (parent as Record<string | number, Json>)[key]!;
  const set = (nv: Json) => {
    (parent as Record<string | number, Json>)[key] = nv;
    changed();
  };
  const ro = depth === 0 && opts.readOnlyKeys?.includes(String(key));
  const del = remove ? h("button", { type: "button", class: "danger", title: "Remove", onclick: remove }, "✕") : "";
  if (v && typeof v === "object") {
    const summary = Array.isArray(v) ? `${label} (${v.length})` : (v as Record<string, Json>).name ? `${label} — ${(v as Record<string, Json>).name}` : label;
    const d = h("details", { class: "obj", open: depth === 0 && !Array.isArray(v) && Object.keys(v).length < 8 }, h("summary", {}, summary, " ", del));
    d.append(node(v, changed, opts, depth + 1));
    return d;
  }
  let input: HTMLElement;
  if (typeof v === "boolean") input = h("input", { type: "checkbox", checked: v, disabled: ro, onchange: (e: Event) => set((e.target as HTMLInputElement).checked) });
  else if (typeof v === "number")
    input = h("input", { type: "number", value: String(v), step: "any", disabled: ro, oninput: (e: Event) => set(Number((e.target as HTMLInputElement).value)) });
  else if (typeof v === "string" && HEX.test(v)) {
    const text = h("input", { type: "text", value: v, style: "width:90px" }) as HTMLInputElement;
    const pick = h("input", { type: "color", value: v }) as HTMLInputElement;
    pick.oninput = () => ((text.value = pick.value), set(pick.value));
    text.oninput = () => HEX.test(text.value) && ((pick.value = text.value), set(text.value));
    input = h("div", { class: "row" }, pick, text);
  } else if (typeof v === "string" && (v.length > 60 || LONG_KEYS.test(String(key))))
    input = h("textarea", { rows: Math.min(6, Math.ceil(v.length / 70) + 1), disabled: ro, oninput: (e: Event) => set((e.target as HTMLTextAreaElement).value) }, v);
  else input = h("input", { type: "text", value: v === null ? "" : String(v), disabled: ro, oninput: (e: Event) => set((e.target as HTMLInputElement).value) });
  return h("div", { class: "field" }, h("label", {}, label), h("div", { class: "row" }, input, del));
}

function blank(v: Json): Json {
  if (Array.isArray(v)) return [];
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, blank(x)]));
  if (typeof v === "number") return 0;
  if (typeof v === "boolean") return false;
  if (typeof v === "string" && HEX.test(v)) return "#888888";
  return "";
}
