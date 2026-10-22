// Meshy image-to-3D. The approved GPT concept image is sent directly as a
// base64 data URI, with the bible's poly budget as the target polycount.
import { checkedJson, defaultServices, type Fetch, type Services } from "./services";

export interface MeshyTask {
  id: string;
  status: "PENDING" | "IN_PROGRESS" | "SUCCEEDED" | "FAILED" | "CANCELED" | string;
  progress?: number;
  model_urls?: { glb?: string; fbx?: string; obj?: string; usdz?: string };
  thumbnail_url?: string;
  task_error?: { message?: string };
}

export interface MeshyOptions {
  apiKey: string;
  services?: Services;
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (task: MeshyTask) => void;
}

export function toDataUri(bytes: Uint8Array, mime = "image/png"): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

export function imageTo3DBody(imageDataUri: string, targetPolycount: number, services: Services = defaultServices) {
  const m = services.meshy;
  return {
    image_url: imageDataUri,
    ai_model: m.aiModel,
    topology: m.topology,
    target_polycount: targetPolycount,
    should_remesh: true,
    should_texture: m.shouldTexture,
    enable_pbr: m.enablePbr,
  };
}

export async function createImageTo3D(o: MeshyOptions, imageDataUri: string, targetPolycount: number): Promise<string> {
  const cfg = o.services ?? defaultServices;
  const res = await (o.fetch ?? fetch)(`${cfg.meshy.baseUrl}/image-to-3d`, {
    method: "POST",
    headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(imageTo3DBody(imageDataUri, targetPolycount, cfg)),
  });
  const json = await checkedJson<{ result: string }>("Meshy", res);
  if (!json.result) throw new Error("Meshy returned no task id");
  return json.result;
}

export async function getImageTo3D(o: MeshyOptions, taskId: string): Promise<MeshyTask> {
  const cfg = o.services ?? defaultServices;
  const res = await (o.fetch ?? fetch)(`${cfg.meshy.baseUrl}/image-to-3d/${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${o.apiKey}` },
  });
  return checkedJson<MeshyTask>("Meshy", res);
}

export async function waitForImageTo3D(o: MeshyOptions, taskId: string): Promise<MeshyTask> {
  const cfg = (o.services ?? defaultServices).meshy;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + cfg.timeoutMinutes * 60_000;
  for (;;) {
    const task = await getImageTo3D(o, taskId);
    o.onProgress?.(task);
    if (task.status === "SUCCEEDED") return task;
    if (task.status === "FAILED" || task.status === "CANCELED")
      throw new Error(`Meshy task ${taskId} ${task.status}: ${task.task_error?.message ?? "no reason given"}`);
    if (Date.now() > deadline) throw new Error(`Meshy task ${taskId} timed out`);
    await sleep(cfg.pollSeconds * 1000);
  }
}

export async function downloadBytes(url: string, f: Fetch = fetch): Promise<Uint8Array> {
  const res = await f(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}
