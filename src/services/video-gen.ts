/**
 * fal.ai Hailuo video generation.
 *
 * IMPORTANT: Pin the exact endpoint slug against the live model card before
 * shipping. fal.ai ships multiple Hailuo variants with differing params.
 */
import { fal } from "@fal-ai/client";

const MODEL_ID = "fal-ai/minimax-hailuo-02";

export interface PollResult {
  done: boolean;
  url?: string;
}

function configureFal(env: CloudflareEnv) {
  fal.config({ credentials: env.FAL_KEY });
}

export async function submitVideoJob(
  env: CloudflareEnv,
  prompt: string,
): Promise<string> {
  configureFal(env);
  const { request_id } = await fal.queue.submit(MODEL_ID, {
    input: {
      prompt,
      aspect_ratio: "9:16",
    },
  });
  return request_id;
}

export async function pollVideoJob(
  env: CloudflareEnv,
  requestId: string,
): Promise<PollResult> {
  configureFal(env);
  const status = await fal.queue.status(MODEL_ID, { requestId });

  if (status.status === "COMPLETED") {
    const result = await fal.queue.result(MODEL_ID, { requestId });
    const url =
      (result?.data as { video?: { url?: string } } | undefined)?.video?.url;
    if (!url) throw new Error("fal.ai: completed but missing video url");
    return { done: true, url };
  }
  // fal.ai returns IN_QUEUE / IN_PROGRESS while working. Anything else
  // outside COMPLETED is treated as not-done-yet.
  return { done: false };
}
