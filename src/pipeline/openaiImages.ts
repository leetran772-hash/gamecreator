// GPT image generation. With style references (approved concepts and user
// uploads from the bible) it uses the edits endpoint so new concepts stay on-style.
import { checkedJson, defaultServices, type Fetch, type Services } from "./services";

export interface ImageRequest {
  prompt: string;
  apiKey: string;
  /** PNG/JPEG bytes of approved concepts to keep the look consistent. */
  references?: { name: string; bytes: Uint8Array; mime: string }[];
  services?: Services;
  fetch?: Fetch;
}

interface ImagesResponse {
  data: { b64_json?: string }[];
}

export async function generateImage(req: ImageRequest): Promise<Uint8Array> {
  const cfg = (req.services ?? defaultServices).openai;
  const f = req.fetch ?? fetch;
  const auth = { Authorization: `Bearer ${req.apiKey}` };
  let res: Response;
  if (req.references?.length) {
    const form = new FormData();
    form.set("model", cfg.imageModel);
    form.set("prompt", req.prompt);
    form.set("size", cfg.size);
    form.set("quality", cfg.quality);
    for (const r of req.references) form.append("image[]", new Blob([new Uint8Array(r.bytes)], { type: r.mime }), r.name);
    res = await f(`${cfg.baseUrl}/images/edits`, { method: "POST", headers: auth, body: form });
  } else {
    res = await f(`${cfg.baseUrl}/images/generations`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ model: cfg.imageModel, prompt: req.prompt, size: cfg.size, quality: cfg.quality, n: 1 }),
    });
  }
  const json = await checkedJson<ImagesResponse>("OpenAI", res);
  const b64 = json.data[0]?.b64_json;
  if (!b64) throw new Error("OpenAI returned no image data");
  return Uint8Array.from(Buffer.from(b64, "base64"));
}
