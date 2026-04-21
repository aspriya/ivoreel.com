/**
 * Hand-written shape of the Worker's `env`. In practice, run
 *   `npm run cf-typegen`
 * after editing `wrangler.jsonc` to regenerate this file from the bindings.
 *
 * Kept here as a stub so TypeScript compiles before the first generation.
 */
import type {
  D1Database,
  KVNamespace,
  R2Bucket,
  Workflow,
} from "@cloudflare/workers-types";

declare global {
  interface CloudflareEnv {
    // Bindings
    REEL_BUCKET: R2Bucket;
    DB: D1Database;
    JOB_STATUS: KVNamespace;
    RATE_LIMIT: KVNamespace;
    REEL_FLOW: Workflow;

    // Secrets
    OPENAI_API_KEY: string;
    ELEVENLABS_API_KEY?: string;
    ASSEMBLYAI_API_KEY: string;
    FAL_KEY: string;
    PEXELS_API_KEY?: string;

    R2_S3_ENDPOINT: string;
    R2_ACCESS_KEY_ID: string;
    R2_SECRET_ACCESS_KEY: string;
    R2_BUCKET: string;

    TRIGGER_SECRET_KEY: string;
    WEBHOOK_SIGNING_SECRET: string;

    AUTH_SECRET: string;
    AUTH_TRUST_HOST?: string;
    AUTH_GOOGLE_ID: string;
    AUTH_GOOGLE_SECRET: string;

    // Vars
    CF_WORKER_URL: string;
  }
}

export {};
