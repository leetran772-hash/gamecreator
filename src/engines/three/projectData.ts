// Every project folder is bundled into the preview; ?project=<name> picks one.
// In dev, editing a bible file reloads the preview with the new data.
import type { Bible } from "../../bible/types";
import type { GameDescription } from "../../core/description";
import type { Registry } from "../../pipeline/registry";

const layers = import.meta.glob("../../../projects/*/bible/*.json", { eager: true, import: "default" }) as Record<string, unknown>;
const games = import.meta.glob("../../../projects/*/game.json", { eager: true, import: "default" }) as Record<string, GameDescription>;
const registries = import.meta.glob("../../../projects/*/assets.json", { eager: true, import: "default" }) as Record<string, Registry>;
const files = import.meta.glob(["../../../projects/*/assets/**/*.glb", "../../../projects/*/assets/**/*.ogg"], {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const PREFIX = "../../../projects/";

export interface ProjectData {
  name: string;
  bible: Bible;
  description: GameDescription;
  registry: Registry;
  /** Resolves a project-relative path (e.g. assets/models/rat.glb) to a served URL. */
  fileUrl(path?: string): string | undefined;
}

export function projectNames(): string[] {
  return Object.keys(games).map((k) => k.slice(PREFIX.length).split("/")[0]!).sort();
}

export function loadProjectData(name: string): ProjectData {
  const game = games[`${PREFIX}${name}/game.json`];
  if (!game) throw new Error(`No project "${name}". Available: ${projectNames().join(", ")}`);
  const bible: Record<string, unknown> = {};
  for (const layer of ["meta", "visual", "audio", "lore", "code"]) {
    const data = layers[`${PREFIX}${name}/bible/${layer}.json`];
    if (!data) throw new Error(`Project ${name} is missing bible/${layer}.json`);
    bible[layer] = structuredClone(data);
  }
  return {
    name,
    bible: bible as unknown as Bible,
    description: structuredClone(game),
    registry: registries[`${PREFIX}${name}/assets.json`] ?? { assets: [] },
    fileUrl: (path) => (path ? files[`${PREFIX}${name}/${path.replace(/^\.?\//, "")}`] : undefined),
  };
}
