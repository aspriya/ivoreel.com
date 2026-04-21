/**
 * GET /api/download/{jobId} — stream the final reel back to the client.
 *
 * Ownership-verified; uses the R2 binding (not presigned URLs) so the Worker
 * stays in the trust boundary. Zero egress cost on R2.
 */
import { auth } from "@/auth";
import { getCloudflareContext } from "@opennextjs/cloudflare";

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

  const row = await env.DB.prepare(
    "SELECT user_id, output_key FROM jobs WHERE id = ?",
  )
    .bind(jobId)
    .first<{ user_id: string; output_key: string | null }>();

  if (!row) return new Response("Not found", { status: 404 });
  if (row.user_id !== session.user.id) {
    return new Response("Forbidden", { status: 403 });
  }
  if (!row.output_key) {
    return new Response("Not ready", { status: 409 });
  }

  const obj = await env.REEL_BUCKET.get(row.output_key);
  if (!obj) return new Response("File not found", { status: 404 });

  const headers = new Headers();
  headers.set("Content-Type", "video/mp4");
  headers.set("Content-Disposition", `attachment; filename="reel-${jobId}.mp4"`);
  if (obj.size) headers.set("Content-Length", String(obj.size));

  // @ts-expect-error — ReadableStream body is valid in Workers
  return new Response(obj.body, { headers });
}
