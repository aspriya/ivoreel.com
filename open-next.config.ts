// @ts-expect-error — types come from the installed package at build time.
import { defineCloudflareConfig } from "@opennextjs/cloudflare";
// @ts-expect-error
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";

export default defineCloudflareConfig({
  // Use R2 as the ISR / fetch cache so we don't rely on Vercel's infra.
  incrementalCache: r2IncrementalCache,
});
