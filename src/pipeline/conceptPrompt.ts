// Prompt templates for GPT image generation. Mood art and asset concepts use
// separate templates: asset concepts must be Meshy-friendly because the
// approved image is the exact input Meshy turns into a 3D model.
import type { Bible } from "../bible/types";

export type AssetKind = "character" | "creature" | "prop" | "environment";

export const MESHY_FRIENDLY_RULES = [
  "Single object, centered, on a plain neutral light-grey background.",
  "Front or three-quarter view, orthographic feel: no perspective distortion, nothing cropped at the edges.",
  "Even, soft studio lighting with no heavy or cast shadows (they would get baked into the textures).",
  "No text, labels, frames, watermarks or extra objects.",
] as const;

const KIND_RULES: Record<AssetKind, string[]> = {
  character: ["Full body, standing in a neutral A-pose, arms slightly away from the body, no props overlapping the body."],
  creature: ["Full body, standing, limbs clearly separated from the body, nothing overlapping the silhouette."],
  prop: ["Whole object visible, shown at a readable angle, no hands or characters holding it."],
  environment: ["One modular piece (not a whole scene), shown on its own, edges fully visible."],
};

function paletteLine(bible: Bible): string {
  return Object.entries(bible.visual.palette)
    .map(([name, hex]) => `${name} ${hex}`)
    .join(", ");
}

/** Asset concept: the image Meshy will turn into a model. */
export function buildAssetConceptPrompt(bible: Bible, subject: string, kind: AssetKind, description = ""): string {
  return [
    `Concept art of ${subject} for a 3D game asset.${description ? ` ${description}` : ""}`,
    `Game style: ${bible.meta.style}. ${bible.visual.styleNotes}`,
    `Use only colors close to this palette: ${paletteLine(bible)}.`,
    `Simple shapes that read well as a low-poly 3D model.`,
    ...KIND_RULES[kind],
    ...MESHY_FRIENDLY_RULES,
  ].join("\n");
}

/** Mood art: atmosphere and key art, never sent to Meshy. */
export function buildMoodPrompt(bible: Bible, scene: string): string {
  return [
    `Key art for the game "${bible.meta.title}": ${scene}.`,
    `Pitch: ${bible.meta.pitch}`,
    `Style: ${bible.meta.style}. ${bible.visual.styleNotes}`,
    `Palette: ${paletteLine(bible)}. Tone: ${bible.lore.tone}`,
    "Cinematic composition, dramatic lighting welcome.",
  ].join("\n");
}

export function polyBudgetFor(bible: Bible, kind: AssetKind): number {
  const b = bible.visual.polyBudgets;
  return kind === "prop" ? b.prop : kind === "environment" ? b.environment : b.character;
}
