/**
 * AssemblyAI word-level alignment.
 *
 * We stream the R2 audio bytes straight to AssemblyAI's /v2/upload endpoint
 * to avoid needing R2 signed URLs. The workflow orchestrator alternates
 * `submit` -> step.sleep -> `poll` until the transcript is ready.
 */
import type { CaptionsDoc, CaptionWord } from "@/src/types";

interface AaiWord {
  text: string;
  start: number; // ms
  end: number;   // ms
  confidence: number;
}

interface AaiTranscript {
  id: string;
  status: "queued" | "processing" | "completed" | "error";
  words?: AaiWord[];
  audio_duration?: number; // seconds
  error?: string;
}

/**
 * Stream an R2 object body into AssemblyAI /v2/upload and return the
 * `upload_url` they give back.
 */
export async function uploadR2AudioToAssemblyAi(
  env: CloudflareEnv,
  key: string,
): Promise<string> {
  const obj = await env.REEL_BUCKET.get(key);
  if (!obj) throw new Error(`assemblyai: audio object missing at ${key}`);

  const res = await fetch("https://api.assemblyai.com/v2/upload", {
    method: "POST",
    headers: {
      Authorization: env.ASSEMBLYAI_API_KEY,
      "Content-Type": "application/octet-stream",
    },
    // ReadableStream body is supported in Workers fetch; cast through unknown
    // because the DOM lib types narrow `BodyInit` more aggressively than Workers.
    body: obj.body as unknown as BodyInit,
  });

  if (!res.ok) {
    throw new Error(`assemblyai-upload: ${res.status} ${await res.text()}`);
  }
  const { upload_url } = (await res.json()) as { upload_url: string };
  return upload_url;
}

export async function submitAlignment(
  audioKey: string,
  _jobId: string,
  env: CloudflareEnv,
): Promise<string> {
  const uploadUrl = await uploadR2AudioToAssemblyAi(env, audioKey);

  const res = await fetch("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: {
      Authorization: env.ASSEMBLYAI_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ audio_url: uploadUrl }),
  });
  if (!res.ok) throw new Error(`assemblyai-submit: ${res.status} ${await res.text()}`);
  const { id } = (await res.json()) as { id: string };
  return id;
}

/**
 * Poll once. Returns null if still in progress, a CaptionsDoc when done,
 * or throws on a terminal AAI error.
 */
export async function pollAlignment(
  transcriptId: string,
  env: CloudflareEnv,
): Promise<CaptionsDoc | null> {
  const res = await fetch(
    `https://api.assemblyai.com/v2/transcript/${transcriptId}`,
    { headers: { Authorization: env.ASSEMBLYAI_API_KEY } },
  );
  if (!res.ok) throw new Error(`assemblyai-poll: ${res.status}`);
  const body = (await res.json()) as AaiTranscript;

  if (body.status === "error") {
    throw new Error(`assemblyai: ${body.error ?? "unknown"}`);
  }
  if (body.status !== "completed" || !body.words) return null;

  const words: CaptionWord[] = body.words.map((w) => ({
    text: w.text,
    startMs: w.start,
    endMs: w.end,
    timestampMs: Math.round((w.start + w.end) / 2),
    confidence: w.confidence,
  }));

  const durationMs = Math.round((body.audio_duration ?? 0) * 1000) ||
    (words.length ? words[words.length - 1]!.endMs : 0);

  return { words, durationMs };
}
