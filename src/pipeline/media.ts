// Local media processing with ffmpeg/ffprobe (no npm dependencies): loudness
// normalization to OGG Vorbis for music, SFX and voice, and image resizing,
// thumbnails and icons for textures and references.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface MediaTools {
  ffmpeg: string;
  ffprobe: string;
}

export const mediaTools = (env = process.env): MediaTools => ({
  ffmpeg: env.FFMPEG ?? "ffmpeg",
  ffprobe: env.FFPROBE ?? "ffprobe",
});

/** Integrated loudness targets (LUFS) per audio kind. */
export const LOUDNESS_TARGETS = { music: -16, sfx: -14, voice: -16 } as const;
const TRUE_PEAK = -1.5;
const LRA = 11;

function run(bin: string, args: string[]): { stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
    return { stdout, stderr: "" };
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(`${bin} failed: ${(e.stderr ?? e.message).slice(-1500)}`);
  }
}

/** Runs ffmpeg and returns its stderr (where ffmpeg writes logs and filter reports). */
function ffmpeg(tools: MediaTools, args: string[]): string {
  const r =spawnSync(tools.ffmpeg, ["-hide_banner", "-nostdin", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`Could not run ffmpeg (${tools.ffmpeg}): ${r.error.message}. Install ffmpeg or set FFMPEG.`);
  if (r.status !== 0) throw new Error(`ffmpeg failed (${r.status}): ${String(r.stderr).slice(-1500)}`);
  return String(r.stderr);
}

/** Duration in seconds (ffprobe). */
export function probeDuration(file: string, tools = mediaTools()): number {
  const { stdout } = run(tools.ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  const d = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(d)) throw new Error(`ffprobe found no duration in ${file}`);
  return d;
}

/** Container format and first audio codec (ffprobe), e.g. { format: "ogg", codec: "vorbis" }. */
export function probeAudio(file: string, tools = mediaTools()): { format: string; codec: string; duration: number; sampleRate: number } {
  const { stdout } = run(tools.ffprobe, [
    "-v", "error", "-select_streams", "a:0",
    "-show_entries", "format=format_name,duration:stream=codec_name,sample_rate",
    "-of", "json", file,
  ]);
  const j = JSON.parse(stdout) as { format?: { format_name?: string; duration?: string }; streams?: { codec_name?: string; sample_rate?: string }[] };
  return {
    format: j.format?.format_name ?? "",
    codec: j.streams?.[0]?.codec_name ?? "",
    duration: Number.parseFloat(j.format?.duration ?? "0") || 0,
    sampleRate: Number.parseInt(j.streams?.[0]?.sample_rate ?? "0", 10) || 0,
  };
}

interface LoudnormReport {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

function loudnormReport(stderr: string): LoudnormReport {
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("ffmpeg loudnorm printed no report");
  return JSON.parse(stderr.slice(start, end + 1)) as LoudnormReport;
}

/** Integrated loudness (LUFS) of a file, measured with ffmpeg's loudnorm analysis pass. */
export function measureLoudness(file: string, tools = mediaTools()): number {
  const err = ffmpeg(tools, ["-nostats", "-i", file, "-af", `loudnorm=I=-16:TP=${TRUE_PEAK}:LRA=${LRA}:print_format=json`, "-f", "null", "-"]);
  return Number.parseFloat(loudnormReport(err).input_i);
}

export interface ProcessedAudio {
  duration: number;
  /** Target LUFS if normalization ran (silent or very short clips are only converted). */
  lufs?: number;
  measuredLufs: number;
}

/**
 * Two-pass EBU R128 loudness normalization (ffmpeg loudnorm, linear mode) and
 * conversion to OGG Vorbis, 44.1 kHz. Returns the output duration (ffprobe).
 */
export function processAudioToOgg(input: string, output: string, targetLufs: number, tools = mediaTools()): ProcessedAudio {
  mkdirSync(dirname(output), { recursive: true });
  const pass1 = loudnormReport(
    ffmpeg(tools, ["-nostats", "-i", input, "-af", `loudnorm=I=${targetLufs}:TP=${TRUE_PEAK}:LRA=${LRA}:print_format=json`, "-f", "null", "-"]),
  );
  const measured = Number.parseFloat(pass1.input_i);
  const canNormalize = Number.isFinite(measured) && measured > -70;
  const filter = canNormalize
    ? [
        `loudnorm=I=${targetLufs}:TP=${TRUE_PEAK}:LRA=${LRA}`,
        `measured_I=${pass1.input_i}:measured_TP=${pass1.input_tp}:measured_LRA=${pass1.input_lra}`,
        `measured_thresh=${pass1.input_thresh}:offset=${pass1.target_offset}:linear=true`,
      ].join(":")
    : "anull";
  ffmpeg(tools, ["-y", "-i", input, "-vn", "-af", filter, "-ar", "44100", "-c:a", "libvorbis", "-q:a", "5", output]);
  return { duration: probeDuration(output, tools), measuredLufs: measured, ...(canNormalize ? { lufs: targetLufs } : {}) };
}

/** A short real audio file (sine tone) for dry runs, so the ffmpeg step runs for real. */
export function sineWav(output: string, seconds: number, frequency = 440, tools = mediaTools()) {
  mkdirSync(dirname(output), { recursive: true });
  ffmpeg(tools, ["-y", "-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=${seconds}:sample_rate=44100`, "-c:a", "pcm_s16le", output]);
}

/** Sniffs an audio container from its first bytes (for naming raw downloads). */
export function audioExtension(bytes: Uint8Array): string {
  const head = Buffer.from(bytes.slice(0, 4)).toString("latin1");
  if (head === "RIFF") return "wav";
  if (head === "OggS") return "ogg";
  if (head === "fLaC") return "flac";
  return "mp3";
}

/** Image width and height (ffprobe). */
export function probeImage(file: string, tools = mediaTools()): { width: number; height: number } {
  const { stdout } = run(tools.ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", file]);
  const [w, h] = stdout.trim().split("x").map((n) => Number.parseInt(n, 10));
  if (!w || !h) throw new Error(`ffprobe found no image size in ${file}`);
  return { width: w, height: h };
}

function encodeArgs(output: string): string[] {
  if (/\.jpe?g$/i.test(output)) return ["-q:v", "2"];
  if (/\.webp$/i.test(output)) return ["-c:v", "libwebp", "-quality", "90"];
  return [];
}

/** Scales an image so its longest side is at most maxSide (never upscales). Format follows the output extension. */
export function resizeImage(input: string, output: string, maxSide: number, tools = mediaTools()): { width: number; height: number } {
  mkdirSync(dirname(output), { recursive: true });
  const { width, height } = probeImage(input, tools);
  const s = Math.min(1, maxSide / Math.max(width, height));
  const w = Math.max(1, Math.round(width * s));
  const h = Math.max(1, Math.round(height * s));
  ffmpeg(tools, ["-y", "-i", input, "-vf", `scale=${w}:${h}:flags=lanczos`, ...encodeArgs(output), "-frames:v", "1", "-update", "1", output]);
  return { width: w, height: h };
}

/** Square PNG icon: the image fitted into size x size, padded with transparency. */
export function squareIcon(input: string, output: string, size: number, tools = mediaTools()) {
  mkdirSync(dirname(output), { recursive: true });
  const vf = `scale=${size}:${size}:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`;
  ffmpeg(tools, ["-y", "-i", input, "-vf", vf, "-frames:v", "1", "-update", "1", output]);
}
