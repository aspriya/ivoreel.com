/**
 * GET /api/status/{jobId} — Server-Sent Events stream for job progress.
 *
 * - Authenticated and ownership-checked.
 * - Short-lived (~25s) with auto-reconnect; halts on "complete" or "failed".
 */
import { auth } from "@/auth";
import { getCloudflareContext } from "@opennextjs/cloudflare";

const STREAM_BUDGET_MS = 25_000;
const POLL_INTERVAL_MS = 2_000;
const TERMINAL_STAGES = new Set(["complete", "failed"]);

export async function GET(
  _req: Request,
  { params }: { params: { jobId: string } },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { jobId } = params;
  const { env } = getCloudflareContext();

  // Ownership check
  const owner = await env.DB.prepare("SELECT user_id FROM jobs WHERE id = ?")
    .bind(jobId)
    .first<{ user_id: string }>();
  if (!owner) return new Response("Not found", { status: 404 });
  if (owner.user_id !== session.user.id) {
    return new Response("Forbidden", { status: 403 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

      const deadline = Date.now() + STREAM_BUDGET_MS;
      try {
        while (Date.now() < deadline) {
          const raw = await env.JOB_STATUS.get(jobId);
          if (raw) {
            const parsed = JSON.parse(raw);
            send(parsed);
            if (TERMINAL_STAGES.has(parsed.stage)) {
              controller.close();
              return;
            }
          }
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
