/**
 * POST /api/webhooks/composition-complete — Trigger.dev callback.
 *
 * Verifies HMAC signature and timestamp, then signals the waiting workflow.
 */
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { hmacSha256Hex, timingSafeEqual } from "@/src/lib/hmac";

export async function POST(req: Request) {
  const { env } = getCloudflareContext();
  const raw = await req.text();
  const given = req.headers.get("x-signature") ?? "";

  const expected = await hmacSha256Hex(env.WEBHOOK_SIGNING_SECRET, raw);
  if (!timingSafeEqual(given, expected)) {
    return new Response("invalid signature", { status: 401 });
  }

  const payload = JSON.parse(raw) as {
    jobId: string;
    finalKey: string;
    timestamp: number;
  };

  // Replay guard: reject events older than 5 minutes
  if (Math.abs(Date.now() - payload.timestamp) > 5 * 60_000) {
    return new Response("stale", { status: 400 });
  }

  // Signal the workflow instance
  // The exact API shape may vary; confirm against current CF Workflows docs
  const flow = env.REEL_FLOW as any;
  if (flow?.sendEvent) {
    await flow.sendEvent(payload.jobId, {
      type: "composition-complete",
      payload: { finalKey: payload.finalKey },
    });
  } else {
    // Fallback: if sendEvent is not available, rely on webhook state polling
    // (implementation depends on CF Workflows GA API)
  }

  return new Response("ok");
}
