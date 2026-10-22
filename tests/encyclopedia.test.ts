import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import index from "../encyclopedia/index.json";

describe("encyclopedia", () => {
  it("index matches entries and implementation paths exist", () => {
    const ids = new Set(index.entries.map((e) => e.id));
    for (const row of index.entries) {
      const entry = JSON.parse(readFileSync(`encyclopedia/entries/${row.id}.json`, "utf8"));
      expect(entry.id).toBe(row.id);
      for (const key of ["whatItIs", "bibleInputs", "outputs", "implementations", "dependencies", "status", "gotchas"]) expect(entry).toHaveProperty(key);
      for (const path of Object.values(entry.implementations) as (string | null)[])
        if (path?.startsWith("src/")) expect(existsSync(path), path).toBe(true);
      for (const dep of entry.dependencies.hard as string[])
        if (!["item-schema", "openai", "meshy", "blender"].includes(dep)) expect(ids.has(dep), dep).toBe(true);
    }
  });
});
