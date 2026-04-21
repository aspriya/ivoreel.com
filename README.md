# ivoreel.com

AI Faceless Reel Composer — generates vertical 1080×1920 Reels for TikTok, YouTube Shorts, and Facebook Reels from a text script.

## Stack

- **Next.js 15** (App Router) on **Cloudflare Workers** via `@opennextjs/cloudflare`
- **Cloudflare Workflows** for durable orchestration of the AI pipeline
- **Trigger.dev v3** container for Remotion rendering (the one thing Workers can't run)
- **AI services:** OpenAI `gpt-4o-mini-tts`, AssemblyAI (alignment), fal.ai Hailuo (background video)
- **Storage:** Cloudflare R2 (files), D1 (SQLite), KV (job status)
- **Auth:** Auth.js v5 with D1 adapter, Google OAuth

See [`reel_factory_project.md`](./reel_factory_project.md) for the full project spec, architecture diagrams, cost model, and implementation notes.

## Prerequisites

- Node.js 20+ (tested on 22)
- A Cloudflare account with Workers Paid plan ($5/mo) for `cpu_ms` limits
- Wrangler CLI: `npm i -g wrangler`
- Trigger.dev account (free tier is fine for MVP)
- API keys: OpenAI, AssemblyAI, fal.ai, Pexels (optional), Google OAuth

## Setup

```bash
# 1. Install deps
npm install

# 2. Copy env template and fill in secrets
cp .env.example .dev.vars
# edit .dev.vars with your keys

# 3. Create Cloudflare resources (run once per environment)
wrangler d1 create ivoreel-db
wrangler r2 bucket create ivoreel
wrangler kv:namespace create JOB_STATUS
# Paste the returned IDs into wrangler.jsonc

# 4. Apply D1 migrations
wrangler d1 migrations apply ivoreel-db --local      # local dev
wrangler d1 migrations apply ivoreel-db --remote     # production

# 5. Push secrets (one per secret)
wrangler secret put OPENAI_API_KEY
wrangler secret put ASSEMBLYAI_API_KEY
wrangler secret put FAL_KEY
wrangler secret put PEXELS_API_KEY
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
wrangler secret put R2_S3_ENDPOINT
wrangler secret put TRIGGER_SECRET_KEY
wrangler secret put WEBHOOK_SIGNING_SECRET
wrangler secret put AUTH_SECRET
wrangler secret put AUTH_GOOGLE_ID
wrangler secret put AUTH_GOOGLE_SECRET
```

## Development

```bash
# Run locally with Wrangler (uses nodejs_compat)
npm run dev

# Remotion preview (for composition development)
npm run remotion:preview

# Trigger.dev dev (for composition task)
npm run trigger:dev
```

## Deploy

```bash
# 1. Bundle Remotion and upload to R2/Pages (once per Remotion change)
npm run remotion:bundle

# 2. Deploy the Worker
npm run deploy

# 3. Deploy the Trigger.dev task
npm run trigger:deploy
```

## Project structure

See `reel_factory_project.md` §9 for the full tree. Key directories:

- `app/` — Next.js App Router (UI + API routes)
- `src/workflows/` — Cloudflare Workflow definitions
- `src/services/` — AI provider wrappers (TTS, alignment, video gen)
- `src/lib/` — Shared helpers (R2 presigner, HMAC, rate limit, D1, KV)
- `remotion/` — Remotion composition (runs in Trigger.dev)
- `trigger/` — Trigger.dev task definitions

## License

UNLICENSED — proprietary.
