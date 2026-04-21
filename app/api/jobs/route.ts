/**
 * POST /api/jobs — create a new Reel job.
 * Requires authenticated session; rate-limited per user.
 */
import { auth } from "@/auth";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { checkRateLimit } from "@/src/lib/rate-limit";
import { z } from "zod";
import type { ReelJobParams } from "@/src/types";

const CreateJobSchema = z.object({
  narrationText: z.string().min(10).max(2000),
  voiceStylePrompt: z
    .string()
    .max(500)
    .default("Calm, warm, mystical tone. Moderate pace."),
  videoPrompt: z.string().min(10).max(500),
  platform: z
    .enum(["facebook", "tiktok", "youtube_shorts", "all"])
    .default("all"),
  voiceProvider: z.enum(["openai", "elevenlabs"]).default("openai"),
  voiceName: z.string().optional(),
  durationStrategy: z.enum(["loop", "stitch"]).default("loop"),
});

export type CreateJobInput = z.infer<typeof CreateJobSchema>;

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response("Unauthorized", { status: 401 });
  }
  const userId = session.user.id;

  const body = await req.json().catch(() => ({}));
  const parsed = CreateJobSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ issues: parsed.error.issues }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const data = parsed.data;

  const { env } = getCloudflareContext();

  // Rate limit check
  const limit = await checkRateLimit(env.DB, userId);
  if (!limit.ok) {
    return new Response(
      JSON.stringify({ error: limit.reason, retryAfter: limit.retryAfterSeconds }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(limit.retryAfterSeconds ?? 60),
        },
      },
    );
  }

  // Insert job record
  const jobId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO jobs (id, user_id, status, narration_text, voice_style_prompt, video_prompt, voice_provider, voice_name, duration_strategy, platform, created_at)
     VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      jobId,
      userId,
      data.narrationText,
      data.voiceStylePrompt,
      data.videoPrompt,
      data.voiceProvider,
      data.voiceName ?? null,
      data.durationStrategy,
      data.platform,
      Date.now(),
    )
    .run();

  await env.JOB_STATUS.put(
    jobId,
    JSON.stringify({ stage: "queued", progress: 0 }),
  );

  // Dispatch workflow
  const params: ReelJobParams = {
    jobId,
    userId,
    narrationText: data.narrationText,
    voiceStylePrompt: data.voiceStylePrompt,
    videoPrompt: data.videoPrompt,
    voiceProvider: data.voiceProvider,
    voiceName: data.voiceName,
    platform: data.platform,
    durationStrategy: data.durationStrategy,
  };

  // Workflow instance creation (shape depends on Cloudflare Workflows GA API)
  // Cast to any to avoid strict typing until @cloudflare/workers-types catches up
  await (env.REEL_FLOW as any).create({ id: jobId, params });

  return Response.json({
    jobId,
    statusUrl: `/api/status/${jobId}`,
    estimatedSeconds: 180,
  });
}
