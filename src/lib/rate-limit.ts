/**
 * D1-backed per-user rate limiting.
 *
 * Two limits are enforced on `POST /api/jobs`:
 *   - hourly cap (MAX_JOBS_PER_HOUR) via a sliding 1-hour window
 *   - concurrent cap (MAX_CONCURRENT_JOBS) via a live count of running jobs
 *
 * This is intentionally simple SQL and NOT a perfectly atomic rate limiter —
 * it's good enough to prevent accidental spend blow-ups. If you need stricter
 * guarantees, back it with a Durable Object.
 */
import type { D1Database } from "@cloudflare/workers-types";

export const MAX_JOBS_PER_HOUR = 20;
export const MAX_CONCURRENT_JOBS = 3;

export interface RateLimitResult {
  ok: boolean;
  retryAfterSeconds?: number;
  reason?: "hourly" | "concurrent";
}

export async function checkRateLimit(
  db: D1Database,
  userId: string,
): Promise<RateLimitResult> {
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;

  const [hourly, concurrent] = await Promise.all([
    db
      .prepare("SELECT COUNT(*) AS c FROM jobs WHERE user_id = ?1 AND created_at >= ?2")
      .bind(userId, hourAgo)
      .first<{ c: number }>(),
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM jobs WHERE user_id = ?1 AND status IN ('pending','processing')",
      )
      .bind(userId)
      .first<{ c: number }>(),
  ]);

  if ((concurrent?.c ?? 0) >= MAX_CONCURRENT_JOBS) {
    return { ok: false, reason: "concurrent", retryAfterSeconds: 60 };
  }
  if ((hourly?.c ?? 0) >= MAX_JOBS_PER_HOUR) {
    return { ok: false, reason: "hourly", retryAfterSeconds: 60 * 60 };
  }
  return { ok: true };
}
