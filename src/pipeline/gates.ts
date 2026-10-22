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

export function gate(estimate: Estimate, approved: boolean): Estimate {
  if (!approved) throw new ApprovalRequired(estimate);
  return estimate;
}
