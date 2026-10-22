// Loads this project's bible layers and game description.
import type { Bible } from "../../src/bible/types";
import type { GameDescription } from "../../src/core/description";
import meta from "./bible/meta.json";
import visual from "./bible/visual.json";
import audio from "./bible/audio.json";
import lore from "./bible/lore.json";
import code from "./bible/code.json";
import game from "./game.json";

export const bible = { meta, visual, audio, lore, code } as unknown as Bible;
export const description = game as unknown as GameDescription;
