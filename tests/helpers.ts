import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A temp project with a copy of the dungeon-crawler bible (the real project is never touched). */
export function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "gc-"));
  cpSync("projects/dungeon-crawler/bible", join(dir, "bible"), { recursive: true });
  return dir;
}

/** Edits one bible layer JSON in a temp project. */
export function editBible<T>(dir: string, layer: string, fn: (json: T) => void) {
  const p = join(dir, "bible", `${layer}.json`);
  const json = JSON.parse(readFileSync(p, "utf8")) as T;
  fn(json);
  writeFileSync(p, JSON.stringify(json, null, 2));
}

export const readJson = <T>(p: string) => JSON.parse(readFileSync(p, "utf8")) as T;
