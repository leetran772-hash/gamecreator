// Approval gates: expensive steps show a cost estimate and only run once the
// user has said yes.
import { defaultServices, type Services } from "./services";

export interface Estimate {
  step: string;
  service: "openai" | "meshy" | "elevenlabs";
  usd: number;
  credits?: number;
  detail: string;
}

export class ApprovalRequired extends Error {
  constructor(readonly estimate: Estimate) {
    super(`Approval needed: ${estimate.detail} — est. $${estimate.usd.toFixed(2)}${estimate.credits ? ` (${estimate.credits} credits)` : ""}`);
  }
}

export function estimateConcept(s: Services = defaultServices): Estimate {
  return { step: "concept", service: "openai", usd: s.openai.estimatedUsdPerImage, detail: `1 concept image (${s.openai.imageModel})` };
}

export function estimateMeshy(s: Services = defaultServices): Estimate {
  const credits = s.meshy.estimatedCreditsPerModel;
  return {
    step: "image-to-3d",
    service: "meshy",
    credits,
    usd: credits * s.meshy.estimatedUsdPerCredit,
    detail: `Meshy image-to-3D${s.meshy.shouldTexture ? " with textures" : ""}`,
  };
}

/** One ElevenLabs sound effect. */
export function estimateSfx(s: Services = defaultServices): Estimate {
  return { step: "sfx", service: "elevenlabs", usd: s.elevenlabs.estimatedUsdPerSfx, detail: `1 ElevenLabs sound effect (${s.elevenlabs.sfxModel})` };
}

/** One ElevenLabs music track of `seconds` length (billed per minute, rounded up). */
export function estimateMusic(seconds: number, s: Services = defaultServices): Estimate {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return {
    step: "music",
    service: "elevenlabs",
    usd: minutes * s.elevenlabs.estimatedUsdPerMusicMinute,
    detail: `ElevenLabs music track, ${Math.round(seconds)}s (${s.elevenlabs.musicModel})`,
  };
}

/** A batch of voice lines: one combined estimate from the total character count. */
export function estimateVoiceLines(lines: { text: string }[], s: Services = defaultServices): Estimate {
  const chars = lines.reduce((n, l) => n + l.text.length, 0);
  return {
    step: "voice",
    service: "elevenlabs",
    usd: (chars / 1000) * s.elevenlabs.estimatedUsdPer1kTtsChars,
    detail: `${lines.length} voice line(s), ${chars} characters (${s.elevenlabs.ttsModel})`,
  };
}

/** Several paid steps behind one approval (e.g. regenerate = concept + Meshy). */
export function combineEstimates(step: string, parts: Estimate[]): Estimate {
  const credits = parts.reduce((n, p) => n + (p.credits ?? 0), 0);
  return {
    step,
    service: parts[parts.length - 1]!.service,
    usd: parts.reduce((n, p) => n + p.usd, 0),
    ...(credits ? { credits } : {}),
    detail: parts.map((p) => p.detail).join(" + "),
  };
}

export function gate(estimate: Estimate, approved: boolean): Estimate {
  if (!approved) throw new ApprovalRequired(estimate);
  return estimate;
}
