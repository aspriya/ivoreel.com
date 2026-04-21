# Ivoreel — AI Faceless Reel Composer
## Project Description & Technical Architecture

> **Document purpose:** Complete project specification for an AI-powered faceless Reel creation tool. Covers the full pipeline from user input to downloadable MP4, technology stack, API service selection, cost model, and architecture. Written for vibe-coding with AI agents.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Feasibility Analysis — Cloudflare Workers via OpenNext](#2-feasibility-analysis--cloudflare-workers-via-opennext)
3. [Architecture Overview](#3-architecture-overview)
4. [Full Technology Stack](#4-full-technology-stack)
5. [Service-by-Service Decisions](#5-service-by-service-decisions)
6. [Data Flow & Pipeline Steps](#6-data-flow--pipeline-steps)
7. [API Schemas & Interfaces](#7-api-schemas--interfaces)
8. [Cost Model](#8-cost-model)
9. [Project Structure](#9-project-structure)
10. [Development Phases & Build Order](#10-development-phases--build-order)
11. [Environment Variables](#11-environment-variables)
12. [Key Implementation Notes](#12-key-implementation-notes)

---

## 1. Project Overview

**Ivoreel** is a web application that orchestrates multiple AI services to compose faceless vertical video Reels from a text script. The user provides:

- **Narration text** — the words that will be spoken in the Reel
- **Voice style prompt** — instructions for the AI voice (tone, pace, emotion, accent)
- **Video prompt** — description of the background video to generate

The app coordinates three parallel AI pipelines and then composes the outputs into a final downloadable MP4 in the correct dimensions for Facebook Reels, TikTok, and YouTube Shorts (1080×1920, 9:16).

```
User Input
    ├── Narration text + voice style → [Voice API] → MP3 audio + word timestamps
    ├── Narration text + audio → [Alignment] → timed caption JSON (if not from Voice API)
    └── Video prompt → [AI Video API] → background MP4 clip
                                             ↓
                               [Remotion Renderer]
                            audio + captions + video
                                     ↓
                            Final Reel MP4 (1080×1920)
                                     ↓
                           Download / platform export
```

**Target export formats:**
- Facebook Reels: 1080×1920, MP4, H.264, up to 90 seconds
- TikTok: 1080×1920, MP4, H.264, up to 60 seconds
- YouTube Shorts: 1080×1920, MP4, H.264, up to 60 seconds

---

## 2. Feasibility Analysis — Cloudflare Workers via OpenNext

### 2.1 Verdict: Yes — with a clear architectural boundary

Deploying the Next.js frontend on **Cloudflare Workers via `@opennextjs/cloudflare`** is feasible and **actively recommended by Cloudflare** as of December 2025. It is a materially better choice than Vercel for this project specifically because R2 (already the file storage choice) integrates natively with Workers via bindings, eliminating HTTP overhead and egress fees on the storage layer.

However, a hard architectural rule must be respected: **Cloudflare Workers cannot run Remotion's video renderer or FFmpeg**. These tools require Chromium (Remotion) or a native binary (FFmpeg), access to large amounts of memory (512MB+), and bundle sizes far exceeding Workers' 10MB cap. The composition step must run outside Workers in a Node.js environment.

### 2.2 What OpenNext on Workers supports (as of April 2026)

| Next.js Feature | Supported |
|---|---|
| App Router (RSC, Server Actions) | ✅ |
| API Routes | ✅ |
| Server-Side Rendering (SSR) | ✅ |
| Incremental Static Regeneration (ISR) | ✅ via R2 cache |
| Next/Image optimization | ✅ via Cloudflare Images |
| Middleware | ✅ |
| Edge Runtime | ❌ (use Node.js runtime only) |
| next/font | ✅ |
| next.config.js | ✅ |
| Next.js 15 (latest minor) | ✅ |
| Next.js 16 (all minor/patch) | ✅ |
| Windows development | ⚠️ Use WSL |

**Required `wrangler.jsonc` settings:**
```json
{
  "compatibility_date": "2026-04-13",
  "compatibility_flags": ["nodejs_compat"],
  "limits": { "cpu_ms": 30000 }
}
```

**Important:** Remove any `export const runtime = "edge"` from your source files before deploying. All routes must use the Node.js runtime.

### 2.3 Hard limits of Cloudflare Workers

| Limit | Free | Paid | Impact on this project |
|---|---|---|---|
| CPU time per request | 10ms | 5 min max (default 30s) | Frontend requests are fine. Composition CANNOT run here. |
| Memory per isolate | 128MB | 128MB | Remotion needs 512MB+. Must be external. |
| Worker bundle size | 3MB | 10MB | Remotion's deps are 100MB+. Must be external. |
| Subrequests per request | 50 | 10,000 | Fine for dispatching jobs. |
| No native binaries | — | — | No FFmpeg, no Chromium, ever. |

### 2.4 What CAN run in Cloudflare Workers

- ✅ Serving the Next.js UI
- ✅ Handling form submissions and auth
- ✅ Dispatching jobs to Cloudflare Workflows (HTTP trigger)
- ✅ Calling external AI APIs via `fetch()` — network wait time does NOT count toward CPU limit
- ✅ Reading/writing R2 files via native binding
- ✅ Reading/writing D1 database
- ✅ Reading/writing KV for job status
- ✅ Server-Sent Events (SSE) for real-time progress streaming to the frontend

### 2.5 What CANNOT run in Cloudflare Workers

- ❌ `renderMedia()` from Remotion (needs Chromium + 512MB+ RAM + large Node.js deps)
- ❌ FFmpeg binary execution
- ❌ Any operation requiring >10MB bundle size (Remotion alone is ~100MB)

### 2.6 How this changes the architecture vs Vercel

| Component | Vercel approach | Cloudflare approach |
|---|---|---|
| Frontend hosting | Vercel (Next.js native) | CF Workers via OpenNext |
| Frontend cost | $0 (hobby) / $20/mo (pro) | $0 (free) / $5/mo (paid) |
| Storage access | HTTP to R2 (adds latency + egress) | Native R2 binding from Worker (zero latency, zero egress) |
| Job orchestration (steps 1–3) | Trigger.dev | Cloudflare Workflows (native) |
| Composition (step 4) | Trigger.dev | Trigger.dev (external — only for Remotion) |
| Database | Supabase | Cloudflare D1 (SQLite, native binding) |
| Auth | Supabase Auth | Cloudflare or third-party (see §4) |
| Real-time status | Supabase Realtime | Cloudflare KV + SSE |
| Cost at 100 users/mo | ~$0–25/mo | ~$0–5/mo |

**Bottom line:** The Cloudflare-native stack eliminates Supabase entirely (replacing it with D1 + KV), reduces Trigger.dev to only the one step that genuinely needs it (Remotion rendering), and cuts hosting costs by 75%. The trade-off is a slightly more complex auth story and the fact that Remotion MUST run externally.

---

## 3. Architecture Overview

```
┌────────────────────────────────────────────────────────────────────────┐
│                    CLOUDFLARE WORKERS (OpenNext)                       │
│                                                                        │
│  Next.js App Router                                                    │
│  ├── /app/(ui)     — Reel creation form, project dashboard            │
│  ├── /app/api/jobs — POST: create job → trigger CF Workflow           │
│  ├── /app/api/status — GET: SSE stream of job progress from KV        │
│  └── /app/api/auth — Auth endpoints                                   │
│                                                                        │
│  Native Bindings:                                                      │
│  ├── R2 (REEL_BUCKET)       — file storage                            │
│  ├── D1 (DB)                — user data, project metadata             │
│  ├── KV (JOB_STATUS)        — real-time job progress state            │
│  └── Workflows (REEL_FLOW)  — dispatch orchestration jobs             │
└──────────────────────────┬─────────────────────────────────────────────┘
                           │ trigger(jobId, params)
                           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                    CLOUDFLARE WORKFLOWS                                  │
│                                                                          │
│  ReelWorkflow (WorkflowEntrypoint)                                       │
│  ├── step 1: Generate voiceover                                          │
│  │   └── fetch() → OpenAI TTS API → MP3 → upload to R2                  │
│  ├── step 2: Get word-level timestamps                                   │
│  │   └── fetch() → AssemblyAI API → caption JSON → write to KV/R2       │
│  ├── step 3: Generate background video                                   │
│  │   └── fetch() → fal.ai (Hailuo) → poll → MP4 → upload to R2          │
│  ├── step 4: Trigger Remotion composition                                │
│  │   └── fetch() → Trigger.dev API → dispatch renderJob                  │
│  └── step 5: Poll for composition complete → update D1 + KV             │
└──────────────────────────┬───────────────────────────────────────────────┘
                           │ (HTTP trigger to Trigger.dev)
                           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                    TRIGGER.DEV (Node.js container)                       │
│                                                                          │
│  renderReelJob                                                           │
│  ├── Download audio MP3 from R2                                          │
│  ├── Download background video MP4 from R2                               │
│  ├── Fetch caption JSON from R2                                          │
│  ├── Run Remotion renderMedia() → 1080×1920 MP4 with animated captions  │
│  └── Upload final MP4 to R2 → POST webhook to CF Workflow               │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│                    CLOUDFLARE R2 (file storage)                          │
│  jobs/{jobId}/audio.mp3                                                  │
│  jobs/{jobId}/captions.json                                              │
│  jobs/{jobId}/background.mp4                                             │
│  jobs/{jobId}/final_reel.mp4   ← final download                         │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Full Technology Stack

### Core

| Layer | Technology | Version | Cost |
|---|---|---|---|
| Frontend framework | Next.js | 15.x (App Router) | Free |
| Frontend runtime | Cloudflare Workers via `@opennextjs/cloudflare` | Latest | $5/mo (paid plan) |
| Job orchestration (API calls) | Cloudflare Workflows | GA | Pay per CPU ms |
| Job processing (composition) | Trigger.dev | v3 | Free tier / $10/mo |
| Database | Cloudflare D1 (SQLite) | GA | Free / $5/mo |
| File storage | Cloudflare R2 | GA | $0.015/GB/mo, $0 egress |
| Real-time job state | Cloudflare KV | GA | Free tier |
| Language | TypeScript | 5.x | — |

### AI Services

| Purpose | Primary Service | Fallback | Cost per Reel |
|---|---|---|---|
| Voice generation (TTS) | OpenAI `gpt-4o-mini-tts` | ElevenLabs | ~$0.008 |
| Caption alignment (timestamps) | AssemblyAI | Deepgram | ~$0.001 |
| Background video generation | fal.ai → Hailuo 2.3 Fast | Pexels API (free) | ~$0.14–0.25 |
| Caption rendering | Remotion `@remotion/captions` | — | $0 |

### Dependencies

```
# package.json dependencies
next: ^15.0.0
react: ^19.0.0
@opennextjs/cloudflare: latest          # CF Workers adapter
@cloudflare/workers-types: latest       # TypeScript types for CF bindings

# Composition (runs in Trigger.dev container only)
remotion: ^4.0.0
@remotion/captions: ^4.0.0
@remotion/renderer: ^4.0.0

# AI SDK clients
openai: ^4.0.0                          # TTS
assemblyai: ^4.0.0                      # Caption alignment
@fal-ai/client: ^1.0.0                  # Video generation

# R2 presigning (for Trigger.dev access — not needed by Workers bindings)
@aws-sdk/client-s3: ^3.0.0
@aws-sdk/s3-request-presigner: ^3.0.0

# Auth
@auth/d1-adapter: latest                # Auth.js with D1 (fallback: @auth/drizzle-adapter)

# Utilities
zod: ^3.0.0                             # Schema validation
```

---

## 5. Service-by-Service Decisions

### 5.1 Voice Generation — OpenAI `gpt-4o-mini-tts`

**Why:** Cheapest at ~$15/million characters (~$0.015/minute of audio). Accepts natural-language style instructions via the `instructions` parameter — no numeric sliders needed. Returns MP3/WAV directly.

**API call pattern (from CF Workflow step):**
```typescript
const audioResponse = await fetch("https://api.openai.com/v1/audio/speech", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "gpt-4o-mini-tts",
    input: narrationText,
    // Current voices (Apr 2026): alloy, ash, ballad, coral, echo, fable,
    // nova, onyx, sage, shimmer, verse. Treat this as a non-exhaustive
    // enum — verify against the current OpenAI docs before shipping.
    voice: "nova",
    instructions: voiceStylePrompt,  // e.g. "Speak slowly and mystically, like a cosmic guide"
    response_format: "mp3",
  }),
});
if (!audioResponse.ok) {
  throw new Error(`TTS failed: ${audioResponse.status} ${await audioResponse.text()}`);
}
const audioBuffer = await audioResponse.arrayBuffer();
// upload to R2
```

**Notes:**
- `gpt-4o-mini-tts` does **not** accept the legacy `speed` parameter that `tts-1` / `tts-1-hd` support. Control pacing through the `instructions` field instead (e.g. "slow, measured pace").
- Input text is capped at ~4096 characters per request; our schema caps narration at 2000 characters so one request is always enough.
- The voice list evolves — expose it as a free-form string in the DB and validate against a runtime-fetched allowlist, not a hard-coded TypeScript enum.

**Premium upgrade path:** ElevenLabs via `/v1/text-to-speech/{voice_id}/with-timestamps` — returns both audio AND word timestamps in a single call, eliminating the alignment step entirely. Cost: ~$0.06–0.10 per Reel. Add as a user-selectable premium voice tier.

**Supported `instructions` style examples for astrology content:**
- `"Speak in a calm, wise, mystical tone. Slow pace. Warm and reverent. Like a spiritual guide sharing ancient wisdom."`
- `"Energetic and punchy. Quick pace. Like a social media personality revealing surprising facts."`
- `"Gentle and soothing. Like a meditation guide. Low and soft."`

---

### 5.2 Caption Alignment — AssemblyAI

**Why:** $0.0025/minute. Word-level timestamps included by default. **333 free hours on signup** — covers ~100,000+ one-minute Reels before paying. The JSON response maps directly to Remotion's `Caption` type.

**Audio upload strategy:** The R2 Workers binding does **not** expose `createSignedUrl`, so we cannot hand AssemblyAI a private R2 URL directly. We have two supported paths; pick one per deployment:

1. **Recommended — AssemblyAI `/v2/upload` passthrough.** Stream the audio bytes from R2 straight into AssemblyAI's upload endpoint, then use the returned `upload_url`. Keeps R2 private and avoids any AWS SigV4 code in the Worker.
2. **S3 presigned URL.** Use `@aws-sdk/s3-request-presigner` against the R2 S3-compat endpoint with account-scoped access keys (see §5.9 and §11). More moving parts, but useful if you also need presigned URLs for other downstream services.

**API call pattern (from CF Workflow step, option 1):**
```typescript
// 1. Stream audio from R2 into AssemblyAI's upload endpoint.
const audioObj = await env.REEL_BUCKET.get(`jobs/${jobId}/audio.mp3`);
if (!audioObj) throw new Error("audio missing from R2");
const uploadRes = await fetch("https://api.assemblyai.com/v2/upload", {
  method: "POST",
  headers: {
    Authorization: env.ASSEMBLYAI_API_KEY,
    "Content-Type": "application/octet-stream",
    "Transfer-Encoding": "chunked",
  },
  body: audioObj.body, // ReadableStream — no full buffer in memory
});
if (!uploadRes.ok) throw new Error(`AAI upload failed: ${uploadRes.status}`);
const { upload_url } = await uploadRes.json() as { upload_url: string };

// 2. Kick off the transcription.
const transcriptRes = await fetch("https://api.assemblyai.com/v2/transcript", {
  method: "POST",
  headers: { Authorization: env.ASSEMBLYAI_API_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ audio_url: upload_url }),
});
const { id } = await transcriptRes.json() as { id: string };
return { transcriptId: id };
```

**Polling** must happen at workflow-level, not inside the `step.do` closure above — see §5.4 for the correct `step.sleep` + `step.do` alternation pattern.

**Output JSON structure (stored in R2 as `captions.json`, shaped for Remotion's `Caption`):**
```json
{
  "words": [
    { "text": "Your",   "startMs": 0,   "endMs": 180, "timestampMs": 90,  "confidence": 0.99 },
    { "text": "cosmic", "startMs": 220, "endMs": 520, "timestampMs": 370, "confidence": 0.98 }
  ],
  "durationMs": 28500
}
```

`timestampMs` is required by `@remotion/captions`; emit it as the midpoint of `startMs`/`endMs` during the transform.

---

### 5.3 Background Video Generation — fal.ai (Hailuo 2.x)

**Why:** Best cost-to-quality ratio at ~$0.14–$0.25 per 6-second clip. Ranks #2 globally on Artificial Analysis video quality benchmarks. Supports 9:16 natively. Handles cosmic/mystical aesthetics extremely well.

> ⚠️ **Pin the exact endpoint slug before building.** fal.ai ships many Hailuo variants (`fal-ai/minimax-hailuo-02`, `fal-ai/minimax/hailuo-02-standard`, etc.), each with different fixed durations, parameter names (`aspect_ratio` vs `resolution`), and pricing. The code below assumes a 6-second fixed-duration variant; verify against the live fal.ai model card on the day you implement.

#### 5.3.1 Duration strategy — narration is longer than one clip

AI video clips are short (6s typical). Narrations can be up to ~90 s. We pick **one** of the following strategies per deployment; the MVP ships strategy **(A)** to keep costs predictable:

- **(A) Single clip + Remotion motion (MVP default).** Generate one 6 s clip and, in Remotion, apply a slow Ken-Burns zoom plus a seamless ping-pong loop for the remainder of the audio. Cost: one clip per Reel (~$0.14–$0.25). Best cost/quality trade-off for ambient astrology/mystical content.
- **(B) Multi-clip stitch.** Generate `ceil(durationSec / 6)` clips in parallel, then crossfade in Remotion. Cost scales linearly (~$0.70–$1.25 for a 30 s reel). Use for narrations where visual variety matters.
- **(C) Pexels fallback.** Short-circuit fal.ai entirely for prompts that match our stock allowlist. Cost: free.

Store the strategy on the job record so the renderer knows how to compose the background.

#### 5.3.2 API call pattern (from CF Workflow step)

```typescript
// NOTE: `step.sleep` is a workflow-level primitive; polling lives in the
// orchestrator (§5.4), NOT inside this service function. This helper is
// called from inside a single step.do() and returns once we have a URL.
export async function submitVideoJob(env: Env, prompt: string) {
  const { request_id } = await fal.queue.submit("fal-ai/minimax-hailuo-02", {
    input: {
      prompt,
      aspect_ratio: "9:16",
      // duration may be fixed depending on the chosen model slug
    },
  });
  return request_id;
}

export async function pollVideoJob(env: Env, requestId: string) {
  const status = await fal.queue.status("fal-ai/minimax-hailuo-02", { requestId });
  if (status.status === "COMPLETED") {
    return { done: true, url: status.response?.video?.url as string };
  }
  if (status.status === "FAILED" || status.status === "ERROR") {
    throw new Error(`fal.ai job ${requestId} failed`);
  }
  return { done: false };
}
```

#### 5.3.3 Pexels fallback

```typescript
// Before calling fal.ai, check if the prompt maps to a stock query.
const PEXELS_QUERIES: Record<string, string> = {
  cosmic: "galaxy nebula space",
  mystical: "aurora northern lights",
  spiritual: "stars night sky",
};
// If matched, call Pexels Videos API (free, 20,000 req/month, requires
// attribution per ToS) and skip fal.ai. Saves ~$0.20 per Reel.
```

---

### 5.4 Job Orchestration — Cloudflare Workflows (replaces Trigger.dev for steps 1–3)

Cloudflare Workflows is a **durable execution engine** built on the Workers platform. It runs multi-step processes that can span minutes, pause for external events, automatically retry failed steps, and persist state. Critically, **network wait time (fetch calls) does NOT count as CPU time** — so waiting for a 60-second AI video generation API is free from a billing perspective.

**Key benefits over Trigger.dev for steps 1–3:**
- No separate service to manage — native to the CF stack
- Direct R2/KV/D1 binding access within workflow steps
- Automatically retries individual failed steps without re-running the whole pipeline
- Free tier: generous; paid is CPU-ms-based (idle costs nothing)
- `step.sleep()` for polling without burning compute

**Critical patterns to get right:**
- `step.sleep` is a **workflow-level primitive**. Never call it from inside a `step.do` closure — the sleep won't be durable and the API is not in scope there. Instead, alternate `step.do(submit)` → `step.sleep("wait", "3 seconds")` → `step.do(poll)` in a bounded loop.
- Polling loops should have an explicit max-iteration guard; otherwise a hung upstream API hangs the workflow until the 10-minute `waitForEvent` timeout.
- Wrap the whole `run()` body in `try/catch` and write a terminal `failed` record to D1 + KV so the UI can surface the error instead of hanging.

**Workflow definition:**
```typescript
// src/workflows/reel-workflow.ts
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";

interface ReelJobParams {
  jobId: string;
  narrationText: string;
  voiceStylePrompt: string;
  videoPrompt: string;
  userId: string;
}

const MAX_POLL_ATTEMPTS = 60; // 60 * 5s = 5 min ceiling per external job

export class ReelWorkflow extends WorkflowEntrypoint<Env, ReelJobParams> {
  async run(event: WorkflowEvent<ReelJobParams>, step: WorkflowStep) {
    const { jobId, narrationText, voiceStylePrompt, videoPrompt } = event.payload;

    try {
      // Step 1 — Generate voiceover (pure HTTP fetch, retryable)
      const audioKey = await step.do("generate-audio", async () => {
        const audio = await generateVoiceover(narrationText, voiceStylePrompt, this.env);
        await this.env.REEL_BUCKET.put(`jobs/${jobId}/audio.mp3`, audio);
        await this.env.JOB_STATUS.put(jobId, JSON.stringify({ stage: "audio_done", progress: 25 }));
        return `jobs/${jobId}/audio.mp3`;
      });

      // Step 2 — Kick off alignment, then poll at workflow-level
      const transcriptId = await step.do("submit-alignment", async () =>
        submitAlignment(audioKey, jobId, this.env)
      );
      let captions: CaptionsDoc | null = null;
      for (let i = 0; i < MAX_POLL_ATTEMPTS && !captions; i++) {
        await step.sleep(`wait-alignment-${i}`, "3 seconds");
        captions = await step.do(`poll-alignment-${i}`, async () =>
          pollAlignment(transcriptId, this.env)
        );
      }
      if (!captions) throw new Error("alignment timed out");
      const captionsKey = await step.do("store-captions", async () => {
        await this.env.REEL_BUCKET.put(`jobs/${jobId}/captions.json`, JSON.stringify(captions));
        await this.env.JOB_STATUS.put(jobId, JSON.stringify({ stage: "captions_done", progress: 50 }));
        return `jobs/${jobId}/captions.json`;
      });

      // Step 3 — Kick off fal.ai, poll at workflow-level, then download to R2
      const videoRequestId = await step.do("submit-video", async () =>
        submitVideoJob(this.env, videoPrompt)
      );
      let videoUrl: string | null = null;
      for (let i = 0; i < MAX_POLL_ATTEMPTS && !videoUrl; i++) {
        await step.sleep(`wait-video-${i}`, "5 seconds");
        const res = await step.do(`poll-video-${i}`, async () =>
          pollVideoJob(this.env, videoRequestId)
        );
        if (res.done) videoUrl = res.url;
      }
      if (!videoUrl) throw new Error("video generation timed out");
      const videoKey = await step.do("store-video", async () => {
        const res = await fetch(videoUrl!);
        if (!res.ok || !res.body) throw new Error(`video download failed: ${res.status}`);
        await this.env.REEL_BUCKET.put(`jobs/${jobId}/background.mp4`, res.body);
        await this.env.JOB_STATUS.put(jobId, JSON.stringify({ stage: "video_done", progress: 75 }));
        return `jobs/${jobId}/background.mp4`;
      });

      // Step 4 — Trigger Remotion composition (external, in Trigger.dev).
      // Generate short-lived S3 presigned URLs here so the Trigger.dev task
      // can pull assets without Workers bindings (see §5.9 + §11).
      await step.do("trigger-composition", async () => {
        const [audioUrl, captionsUrl, videoDlUrl, uploadUrl] = await Promise.all([
          presignGet(this.env, audioKey, 3600),
          presignGet(this.env, captionsKey, 3600),
          presignGet(this.env, videoKey, 3600),
          presignPut(this.env, `jobs/${jobId}/final_reel.mp4`, 3600),
        ]);
        const res = await fetch("https://api.trigger.dev/api/v1/tasks/render-reel/trigger", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.env.TRIGGER_SECRET_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            jobId,
            audioUrl,
            captionsUrl,
            videoUrl: videoDlUrl,
            uploadUrl,
            webhookUrl: `${this.env.CF_WORKER_URL}/api/webhooks/composition-complete`,
          }),
        });
        if (!res.ok) throw new Error(`trigger.dev dispatch failed: ${res.status}`);
        await this.env.JOB_STATUS.put(jobId, JSON.stringify({ stage: "composing", progress: 80 }));
      });

      // Step 5 — Wait for composition webhook
      const { finalKey } = await step.waitForEvent<{ finalKey: string }>(
        "composition-complete",
        { type: "composition-complete", timeout: "15 minutes" }
      );

      await step.do("mark-complete", async () => {
        await this.env.DB.prepare(
          "UPDATE jobs SET status='complete', output_key=?, completed_at=? WHERE id=?"
        ).bind(finalKey, Date.now(), jobId).run();
        await this.env.JOB_STATUS.put(
          jobId,
          JSON.stringify({ stage: "complete", progress: 100, outputKey: finalKey })
        );
      });
    } catch (err) {
      // Best-effort terminal-failure record so the UI can stop waiting.
      const message = err instanceof Error ? err.message : String(err);
      await step.do("mark-failed", async () => {
        await this.env.DB.prepare(
          "UPDATE jobs SET status='failed', completed_at=? WHERE id=?"
        ).bind(Date.now(), jobId).run();
        await this.env.JOB_STATUS.put(
          jobId,
          JSON.stringify({ stage: "failed", progress: 0, error: message }),
          { expirationTtl: 60 * 60 * 24 } // auto-evict after a day
        );
      });
      throw err; // let Workflows mark the run as failed too
    }
  }
}
```

**`waitForEvent` API note:** The `cloudflare:workers` Workflows API has evolved; confirm the exact signature (positional `name` + options vs. a single options object, and whether the callback-style signaller is `env.REEL_FLOW.sendEvent(instanceId, { type, payload })` or similar) against the current Cloudflare docs for your compatibility date. The shape shown above reflects the GA API at time of writing.

---

### 5.5 Video Composition — Remotion in Trigger.dev

This is the **only component that must run outside Cloudflare Workers**. Remotion renders React components to MP4 frames using a headless Chromium browser. It requires Node.js, ~512MB RAM, and its dependencies exceed Workers' 10MB bundle limit.

**Deployment prerequisites — do not skip:**

1. **Chromium in the container.** Remotion needs a real Chrome build. In `trigger.config.ts`, use `@trigger.dev/build/extensions/core` to install Chromium dependencies, or call `ensureBrowser()` from `@remotion/renderer` during cold start. Without this the task crashes on first render.
2. **Remotion serve bundle.** `selectComposition` + `renderMedia` require a `serveUrl` pointing at a built Remotion bundle. Two options:
   - **Bundle in-task once per cold start** using `bundle()` from `@remotion/bundler`, cache the path in module scope. Simpler, adds ~10–20 s to cold starts.
   - **Pre-bundle in CI** (`npx remotion bundle ./remotion/index.ts`), upload the `out/` directory to R2 or Cloudflare Pages, set `REMOTION_SERVE_URL` to the public URL. Faster cold starts, extra deploy step.
3. **No Workers R2 binding here.** Trigger.dev receives short-lived S3 presigned `GET` URLs for inputs and a presigned `PUT` URL for the output, dispatched from the CF Workflow step (§5.4). R2 S3 credentials live only in the Worker — the Trigger.dev task never sees them.
4. **Webhook must be HMAC-signed.** The task signs its completion callback with `WEBHOOK_SIGNING_SECRET` so the Worker can verify it (§5.4 webhook receiver).

**Trigger.dev task:**
```typescript
// trigger/render-reel.ts
import { task } from "@trigger.dev/sdk/v3";
import { renderMedia, selectComposition, ensureBrowser } from "@remotion/renderer";
import { promises as fs } from "node:fs";
import { createHmac } from "node:crypto";
import path from "node:path";
import os from "node:os";

export const renderReel = task({
  id: "render-reel",
  maxDuration: 600, // 10 minutes
  run: async (payload: {
    jobId: string;
    audioUrl: string;
    captionsUrl: string;
    videoUrl: string;     // presigned GET for the 6s background clip
    uploadUrl: string;    // presigned PUT for final_reel.mp4
    webhookUrl: string;
    durationStrategy?: "loop" | "stitch";
  }) => {
    const { jobId, audioUrl, captionsUrl, videoUrl, uploadUrl, webhookUrl } = payload;

    await ensureBrowser(); // idempotent; installs Chromium on first call

    // 1. Download assets via presigned URLs (NOT Workers bindings)
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "reel-"));
    const audioPath = path.join(tmpDir, "audio.mp3");
    const videoPath = path.join(tmpDir, "background.mp4");
    const [audioRes, captionsRes, videoRes] = await Promise.all([
      fetch(audioUrl),
      fetch(captionsUrl),
      fetch(videoUrl),
    ]);
    for (const [name, res] of [["audio", audioRes], ["captions", captionsRes], ["video", videoRes]] as const) {
      if (!res.ok) throw new Error(`fetch ${name} failed: ${res.status}`);
    }
    await fs.writeFile(audioPath, Buffer.from(await audioRes.arrayBuffer()));
    await fs.writeFile(videoPath, Buffer.from(await videoRes.arrayBuffer()));
    const captionsJson = await captionsRes.json();

    // 2. Remotion composition selection + render
    const serveUrl = process.env.REMOTION_SERVE_URL!;
    const durationMs: number = captionsJson.durationMs;
    const fps = 30;
    const durationInFrames = Math.ceil((durationMs / 1000) * fps);

    const composition = await selectComposition({
      serveUrl,
      id: "ReelComposition",
      inputProps: {
        audioFile: audioPath,
        backgroundVideoFile: videoPath,
        captions: captionsJson.words,
        durationMs,
        durationStrategy: payload.durationStrategy ?? "loop",
        captionStyle: {
          fontFamily: "Montserrat",
          fontSize: 72,
          activeColor: "#FFD700",
          inactiveColor: "#FFFFFF",
          backgroundColor: "rgba(0,0,0,0.4)",
          animation: "bounce",
        },
      },
    });

    const outputLocation = path.join(tmpDir, "final.mp4");
    await renderMedia({
      composition: { ...composition, durationInFrames, fps, width: 1080, height: 1920 },
      serveUrl,
      codec: "h264",
      outputLocation,
      imageFormat: "jpeg",
      jpegQuality: 80,
    });

    // 3. Upload final MP4 via presigned PUT (no bindings needed)
    const finalBuffer = await fs.readFile(outputLocation);
    const putRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "video/mp4" },
      body: finalBuffer,
    });
    if (!putRes.ok) throw new Error(`final upload failed: ${putRes.status}`);

    // 4. HMAC-signed webhook back to the CF Worker
    const body = JSON.stringify({
      jobId,
      finalKey: `jobs/${jobId}/final_reel.mp4`,
      timestamp: Date.now(),
    });
    const signature = createHmac("sha256", process.env.WEBHOOK_SIGNING_SECRET!)
      .update(body)
      .digest("hex");
    const webhookRes = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature": signature },
      body,
    });
    if (!webhookRes.ok) throw new Error(`webhook failed: ${webhookRes.status}`);

    // 5. Cleanup
    await fs.rm(tmpDir, { recursive: true, force: true });
  },
});
```

**Remotion `ReelComposition` component (strategy A — loop + Ken-Burns):**

The narration can easily be 3–5× longer than the 6 s background clip. This component ping-pong loops the clip and applies a slow zoom so the visual feels alive for the full duration. For strategy B (multi-clip stitch), swap the single `<Video>` for a `<Series>` of clips with crossfades.

```typescript
// remotion/ReelComposition.tsx
import React from "react";
import {
  AbsoluteFill, Audio, Video, useCurrentFrame, useVideoConfig, interpolate,
} from "remotion";
import { createTikTokStyleCaptions, type Caption } from "@remotion/captions";

interface ReelProps {
  audioFile: string;
  backgroundVideoFile: string;
  captions: Caption[];
  durationMs: number;
  durationStrategy: "loop" | "stitch";
  captionStyle: {
    fontFamily: string;
    fontSize: number;
    activeColor: string;
    inactiveColor: string;
    backgroundColor: string;
    animation: "bounce" | "fade";
  };
}

// The source background clip is ~6s. Ping-pong to hide the loop seam.
const CLIP_SECONDS = 6;

export const ReelComposition: React.FC<ReelProps> = ({
  audioFile, backgroundVideoFile, captions, captionStyle,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const currentMs = (frame / fps) * 1000;

  // Ping-pong clip time so we never freeze or jump-cut.
  const t = frame / fps;
  const cycle = t % (CLIP_SECONDS * 2);
  const clipTimeSec = cycle < CLIP_SECONDS ? cycle : CLIP_SECONDS * 2 - cycle;

  // Slow Ken-Burns zoom across the whole reel.
  const zoom = interpolate(frame, [0, durationInFrames], [1.0, 1.12], {
    extrapolateRight: "clamp",
  });

  const { pages } = createTikTokStyleCaptions({
    captions,
    combineTokensWithinMilliseconds: 500,
  });
  const currentPage = pages.find(p => p.startMs <= currentMs && p.endMs > currentMs);

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <AbsoluteFill style={{ transform: `scale(${zoom})` }}>
        <Video
          src={backgroundVideoFile}
          startFrom={Math.floor(clipTimeSec * fps)}
          endAt={Math.floor(clipTimeSec * fps) + 1}
          muted
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </AbsoluteFill>
      <Audio src={audioFile} />
      {currentPage && (
        <AbsoluteFill style={{ justifyContent: "flex-end", paddingBottom: 120, alignItems: "center" }}>
          <div style={{
            textAlign: "center", padding: "12px 24px", borderRadius: 12,
            backgroundColor: captionStyle.backgroundColor,
          }}>
            {currentPage.tokens.map((token, i) => (
              <span key={i} style={{
                fontSize: captionStyle.fontSize,
                fontFamily: captionStyle.fontFamily,
                fontWeight: 800,
                color: token.isActive ? captionStyle.activeColor : captionStyle.inactiveColor,
                marginRight: 8,
                display: "inline-block",
                transform: token.isActive ? "scale(1.15)" : "scale(1)",
                transition: "transform 0.1s",
              }}>
                {token.text}
              </span>
            ))}
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};
```

> The `startFrom`/`endAt` trick above is illustrative — in practice you'll either pre-generate a ping-pong MP4 with FFmpeg inside the Trigger.dev task or use Remotion's `<OffthreadVideo>` with playback-rate control. Validate on your target clip before shipping.

---

### 5.6 Database — Cloudflare D1

D1 is Cloudflare's serverless SQLite database, accessible via native Workers binding. It replaces Supabase for structured data. No external HTTP calls — queries run in the same edge location as the Worker.

**Schema:**
```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending',
  narration_text TEXT NOT NULL,
  voice_style_prompt TEXT,
  video_prompt TEXT,
  output_key TEXT,
  platform TEXT DEFAULT 'all',
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  CONSTRAINT status_check CHECK (status IN ('pending','processing','complete','failed'))
);

CREATE INDEX idx_jobs_user ON jobs(user_id, created_at DESC);
```

---

### 5.7 Authentication

Options in order of simplicity for a Cloudflare-native stack:

1. **Auth.js v5 with D1 adapter** (`@auth/d1-adapter`) — works directly in Workers. Supports Google, GitHub, Magic Link. Recommended for MVP.
2. **Cloudflare Zero Trust / Access** — enterprise-grade, not ideal for public user auth.
3. **Clerk** — third-party, works in Workers. Free tier currently covers up to 10k MAU; paid plans start above that. Verify pricing at the time of decision.

**Recommended:** Auth.js v5 with D1 adapter and Google OAuth for MVP. Simple, free, integrates natively.

**Gotchas for Auth.js v5 on OpenNext/Workers:**
- Set `AUTH_TRUST_HOST=true` in env; Workers don't expose a stable host header.
- Use the `database` session strategy — D1 lookups per request are cheap via native binding, and JWT callbacks that do DB reads add latency.
- If `@auth/d1-adapter` lags v5 releases, fall back to `@auth/drizzle-adapter` with a D1 dialect (Drizzle has first-party D1 support).
- Cookies must be `Secure` and `SameSite=Lax` on the custom domain — OpenNext preserves these, but verify on first deploy.

---

### 5.8 Real-Time Job Status — Cloudflare KV + Server-Sent Events

Cloudflare Workers support `EventSource` responses for SSE natively, but **a single Worker invocation is capped at 30 s by default (5 min max with `cpu_ms`)**. A naive `while (true)` stream will be killed mid-render. We use a **short-lived, auto-reconnecting SSE** pattern: each response runs for ~25 s, then closes; the browser's `EventSource` reconnects automatically and picks up from the current KV value.

Every stream must also:
- **Authenticate the request** and verify the caller owns `jobId` (D1 lookup).
- **Terminate on the `complete` AND `failed` stages** so the client loop ends cleanly.

For jobs that routinely exceed a few minutes you may prefer a **Durable Object** with WebSocket hibernation — it gives you a single long-lived connection with near-zero idle cost. SSE-with-reconnect is simpler and sufficient for this pipeline's 3–5 min worst case.

**API Route (SSE stream):**
```typescript
// app/api/status/[jobId]/route.ts
import { auth } from "@/auth";
import { getCloudflareContext } from "@opennextjs/cloudflare";

const STREAM_BUDGET_MS = 25_000; // close well before Workers' 30s default
const POLL_INTERVAL_MS = 2_000;
const TERMINAL_STAGES = new Set(["complete", "failed"]);

export async function GET(_req: Request, { params }: { params: { jobId: string } }) {
  const session = await auth();
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 });

  const { jobId } = params;
  const { JOB_STATUS, DB } = getCloudflareContext().env;

  // Ownership check — prevents tailing other users' jobs.
  const owner = await DB.prepare("SELECT user_id FROM jobs WHERE id = ?")
    .bind(jobId).first<{ user_id: string }>();
  if (!owner) return new Response("Not found", { status: 404 });
  if (owner.user_id !== session.user.id) return new Response("Forbidden", { status: 403 });

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (data: object) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

      const deadline = Date.now() + STREAM_BUDGET_MS;
      try {
        while (Date.now() < deadline) {
          const raw = await JOB_STATUS.get(jobId);
          if (raw) {
            const parsed = JSON.parse(raw);
            send(parsed);
            if (TERMINAL_STAGES.has(parsed.stage)) {
              controller.close();
              return;
            }
          }
          await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        }
        // Budget exhausted — close cleanly; client's EventSource will reconnect.
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
      "Connection": "keep-alive",
      // Disable buffering at any intermediate proxy.
      "X-Accel-Buffering": "no",
    },
  });
}
```

**Client side — reconnect automatically and stop on terminal stage:**
```typescript
const es = new EventSource(`/api/status/${jobId}`);
es.onmessage = (e) => {
  const event = JSON.parse(e.data);
  render(event);
  if (event.stage === "complete" || event.stage === "failed") es.close();
};
// Browsers already auto-reconnect on clean close / network error.
```

**Webhook receiver — verify HMAC before trusting the payload:**
```typescript
// app/api/webhooks/composition-complete/route.ts
import { getCloudflareContext } from "@opennextjs/cloudflare";

export async function POST(req: Request) {
  const { env } = getCloudflareContext();
  const raw = await req.text();
  const given = req.headers.get("x-signature") ?? "";
  const expected = await hmacSha256Hex(env.WEBHOOK_SIGNING_SECRET, raw);
  if (!timingSafeEqual(given, expected)) {
    return new Response("invalid signature", { status: 401 });
  }
  const { jobId, finalKey, timestamp } = JSON.parse(raw);
  if (Math.abs(Date.now() - timestamp) > 5 * 60_000) {
    return new Response("stale", { status: 400 }); // replay guard
  }
  // Signal the waiting workflow instance.
  await env.REEL_FLOW.sendEvent(jobId, {
    type: "composition-complete",
    payload: { finalKey },
  });
  return new Response("ok");
}
```

---

### 5.9 File Storage — Cloudflare R2

R2 stores all intermediate and final files. Zero egress fees means users downloading their final Reels costs nothing. Native Workers binding means no HTTP overhead.

**Naming convention:**
```
jobs/{jobId}/audio.mp3           → generated voiceover
jobs/{jobId}/captions.json       → word-level timestamps
jobs/{jobId}/background.mp4      → AI-generated background clip
jobs/{jobId}/final_reel.mp4      → composed final output
jobs/{jobId}/thumb.jpg           → thumbnail (optional)
```

**Signed URLs — the R2 Workers binding does NOT expose `createSignedUrl`.** To generate presigned URLs for Trigger.dev (inputs + final upload) and for user-facing downloads, use the AWS SDK's S3 presigner against R2's S3-compatible endpoint:

```typescript
// src/lib/r2-presign.ts
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function s3(env: Env) {
  return new S3Client({
    region: "auto",
    endpoint: env.R2_S3_ENDPOINT, // https://<account>.r2.cloudflarestorage.com
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
}

export async function presignGet(env: Env, key: string, expiresIn = 3600) {
  return getSignedUrl(
    s3(env),
    new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }),
    { expiresIn }
  );
}

export async function presignPut(env: Env, key: string, expiresIn = 3600) {
  return getSignedUrl(
    s3(env),
    new PutObjectCommand({ Bucket: env.R2_BUCKET, Key: key }),
    { expiresIn }
  );
}
```

**Alternatives to presigned URLs for the end-user download endpoint:**
- **Stream through the Worker:** `GET /api/download/[jobId]` → ownership check → `env.REEL_BUCKET.get(key)` → return the R2 body stream. Zero-egress, zero extra creds, but the request is subject to Worker CPU limits for the duration of the stream start (the body itself streams without CPU cost).
- **Public bucket with token-gated custom domain:** attach a Worker in front of r2.dev that validates a short-lived JWT. Overkill for MVP.

For the MVP, **stream-through-the-Worker** is the simplest path for downloads; presigned URLs are only needed for Trigger.dev.

---

## 6. Data Flow & Pipeline Steps

```
1. USER SUBMITS FORM (Next.js UI on CF Workers)
   ├── POST /api/jobs  (authenticated)
   ├── Per-user rate-limit check (D1 counter)
   ├── Validate input with Zod
   ├── Create job record in D1 (status: pending, user_id: <session>)
   ├── Write initial KV status: { stage: "queued", progress: 0 }
   └── Trigger CF Workflow instance (env.REEL_FLOW.create({ id: jobId, params }))
   └── Return { jobId, statusUrl } to client

2. CLIENT OPENS SSE STREAM
   └── GET /api/status/{jobId}
       ├── Auth check + ownership check against D1
       └── Short-lived EventSource (~25s) — browser auto-reconnects

3. CF WORKFLOW — Step 1: VOICE GENERATION (~5–15 sec)
   ├── step.do: fetch() POST to OpenAI TTS API
   ├── PUT to R2: jobs/{jobId}/audio.mp3  (via binding)
   └── Update KV: { stage: "audio_done", progress: 25 }

4. CF WORKFLOW — Step 2: CAPTION ALIGNMENT (~10–30 sec)
   ├── step.do: stream R2 audio → AssemblyAI /v2/upload → upload_url
   ├── step.do: POST /v2/transcript → transcriptId
   ├── Loop: step.sleep(3s) + step.do(poll) up to MAX_POLL_ATTEMPTS
   ├── step.do: transform + PUT jobs/{jobId}/captions.json
   └── Update KV: { stage: "captions_done", progress: 50 }

5. CF WORKFLOW — Step 3: VIDEO GENERATION (~30–120 sec)
   ├── step.do: fal.queue.submit(...) → request_id
   ├── Loop: step.sleep(5s) + step.do(poll) up to MAX_POLL_ATTEMPTS
   ├── step.do: fetch(videoUrl) → PUT jobs/{jobId}/background.mp4
   └── Update KV: { stage: "video_done", progress: 75 }

6. CF WORKFLOW — Step 4: TRIGGER COMPOSITION (~60–180 sec)
   ├── step.do: generate presigned GET/PUT URLs for audio/captions/video/final
   ├── step.do: POST to Trigger.dev → dispatch renderReel with URLs + webhookUrl
   └── Update KV: { stage: "composing", progress: 80 }

7. TRIGGER.DEV — REMOTION RENDER
   ├── ensureBrowser() (installs Chromium on cold start)
   ├── fetch() presigned URLs → download audio/captions/video to /tmp
   ├── selectComposition + renderMedia → 1080×1920 MP4 with TikTok captions
   ├── PUT final MP4 to presigned upload URL
   └── POST HMAC-signed webhook → /api/webhooks/composition-complete

8. CF WORKFLOW — Step 5: FINALIZE
   ├── Webhook receiver verifies HMAC + timestamp, calls env.REEL_FLOW.sendEvent
   ├── step.waitForEvent("composition-complete") resolves → { finalKey }
   ├── Update D1: status = "complete", output_key = finalKey
   └── Update KV: { stage: "complete", progress: 100, outputKey: finalKey }

   ON FAILURE AT ANY STEP:
   ├── try/catch in workflow writes D1 status = "failed" + KV { stage: "failed", error }
   └── Client SSE receives terminal "failed" event and closes

9. CLIENT RECEIVES COMPLETE STATUS
   ├── SSE stream delivers { stage: "complete", outputKey }
   └── UI shows download button → GET /api/download/{jobId}
       └── Worker verifies ownership, streams R2 body back to client
```

---

## 7. API Schemas & Interfaces

### Create Job

**Request:** `POST /api/jobs` (requires authenticated session; subject to per-user rate limit)
```typescript
const CreateJobSchema = z.object({
  narrationText: z.string().min(10).max(2000),
  voiceStylePrompt: z.string().max(500).default("Calm, warm, mystical tone. Moderate pace."),
  videoPrompt: z.string().min(10).max(500),
  platform: z.enum(["facebook", "tiktok", "youtube_shorts", "all"]).default("all"),
  voiceProvider: z.enum(["openai", "elevenlabs"]).default("openai"),
  voiceName: z.string().optional(),
  // Controls how the 6s background clip is stretched to cover the narration.
  durationStrategy: z.enum(["loop", "stitch"]).default("loop"),
});
```

**Rate-limit recommendation (MVP):** cap each `user_id` to 3 concurrent jobs and ~20 per hour via a D1-backed counter table; return `429` with a `Retry-After` header when exceeded. Revisit once you have real usage data.

**Response:**
```typescript
interface CreateJobResponse {
  jobId: string;
  statusUrl: string;  // /api/status/{jobId}
  estimatedSeconds: number;
}
```

### Job Status (SSE events)

```typescript
type JobStatusEvent =
  | { stage: "queued"; progress: 0 }
  | { stage: "audio_done"; progress: 25 }
  | { stage: "captions_done"; progress: 50 }
  | { stage: "video_done"; progress: 75 }
  | { stage: "composing"; progress: 80 }
  | { stage: "complete"; progress: 100; outputKey: string }
  | { stage: "failed"; progress: number; error: string };
```

---

## 8. Cost Model

### Per-Reel API costs — by duration strategy (30-second Reel)

**Strategy A — single clip + Remotion loop (MVP default):**

| Step | Service | Cost |
|---|---|---|
| Voice (30-sec script, ~500 chars) | OpenAI gpt-4o-mini-tts | ~$0.008 |
| Caption alignment (30 sec audio) | AssemblyAI | ~$0.001 (free for first 333 hrs) |
| Background video (1 × 6-sec clip, Hailuo) | fal.ai | ~$0.14–0.25 |
| Video composition | Remotion + Trigger.dev compute | ~$0.01–0.03 |
| R2 storage + ops | Cloudflare R2 | ~$0.001 |
| **Total per Reel (A)** | | **~$0.16–0.29** |

**Strategy B — multi-clip stitch (`ceil(30/6) = 5` clips):**

| Step | Cost |
|---|---|
| Voice + alignment + composition + R2 | ~$0.02 |
| Background video (5 × 6-sec clips) | ~$0.70–$1.25 |
| **Total per Reel (B)** | **~$0.72–$1.27** |

**Strategy C — Pexels stock fallback:**

| Step | Cost |
|---|---|
| Voice + alignment + composition + R2 | ~$0.02 |
| Background video | $0.00 (attribution required) |
| **Total per Reel (C)** | **~$0.02–$0.05** |

### Monthly infrastructure (at 500 Reels/month)

| Service | Plan | Cost |
|---|---|---|
| Cloudflare Workers (paid) | Workers Paid | $5/mo |
| Cloudflare Workflows | CPU-ms billing | ~$1–3/mo |
| Cloudflare D1 | Free / Pro | $0–5/mo |
| Cloudflare R2 (25GB) | R2 | $0.38/mo |
| Cloudflare KV | Free tier | $0/mo |
| Trigger.dev (composition only) | Free tier / $10/mo | $0–10/mo |
| **Total infrastructure** | | **~$6–24/mo** |

**Total monthly at 500 Reels (strategy A default):** ~$80–145 (AI API) + $6–24 (infra) = **~$86–169/month**.

If you default users to strategy B, AI costs jump to ~$360–635/month at 500 Reels — price accordingly or make B an explicit premium tier.

**Break-even pricing guidance:**
- Strategy A: absolute floor ~$0.30/Reel, healthy margin at ~$0.50–$1.00/Reel.
- Strategy B: absolute floor ~$1.30/Reel, market at ~$2–$3/Reel.
- Strategy C: essentially free; offer as a "stock backgrounds" cheap tier.

---

## 9. Project Structure

```
ivoreel/
├── app/                          # Next.js App Router
│   ├── (auth)/
│   │   └── login/page.tsx
│   ├── (dashboard)/
│   │   ├── page.tsx              # Job list / dashboard
│   │   └── create/page.tsx       # Reel creation form
│   └── api/
│       ├── auth/[...nextauth]/route.ts
│       ├── jobs/route.ts         # POST: create job
│       ├── status/[jobId]/route.ts  # GET: SSE stream
│       ├── download/[jobId]/route.ts
│       └── webhooks/
│           └── composition-complete/route.ts
│
├── src/
│   ├── workflows/
│   │   └── reel-workflow.ts      # CF Workflow definition (submit/poll + try/catch)
│   ├── services/
│   │   ├── tts.ts                # OpenAI / ElevenLabs TTS
│   │   ├── alignment.ts          # AssemblyAI: submit + poll helpers
│   │   ├── video-gen.ts          # fal.ai: submit + poll helpers
│   │   └── pexels.ts             # stock fallback
│   ├── lib/
│   │   ├── r2.ts                 # Workers-binding helpers
│   │   ├── r2-presign.ts         # S3 presigner (GET + PUT)
│   │   ├── d1.ts                 # D1 helpers
│   │   ├── kv.ts                 # KV helpers
│   │   ├── rate-limit.ts         # per-user quota against D1
│   │   └── hmac.ts               # webhook HMAC sign + verify
│   └── types/
│       └── index.ts
│
├── remotion/                     # Remotion project (composition)
│   ├── Root.tsx
│   ├── ReelComposition.tsx
│   └── index.ts
│
├── trigger/                      # Trigger.dev tasks
│   ├── trigger.config.ts         # Chromium build extension
│   └── render-reel.ts
│
├── scripts/
│   └── bundle-remotion.ts        # npx remotion bundle → upload to R2/Pages
│
├── migrations/                   # D1 schema migrations
│   └── 0001_init.sql
│
├── wrangler.jsonc                # Cloudflare Workers config
├── open-next.config.ts           # OpenNext config
├── next.config.ts
├── package.json
└── tsconfig.json
```

---

## 10. Development Phases & Build Order

### Phase 0 — Foundation (Day 1–2)
- [ ] Init Next.js 15 project: `npm create cloudflare@latest ivoreel` and select **Framework = Next.js**, **Deployment = Workers (OpenNext)** at the prompts. (Flag names change across C3 releases — follow the interactive prompts rather than hard-coding `--platform=...`.)
- [ ] Configure `wrangler.jsonc` with D1, KV, R2, and Workflows bindings + `compatibility_flags: ["nodejs_compat"]` + `limits.cpu_ms: 30000`.
- [ ] Create D1 schema + run migrations with `wrangler d1 migrations create` / `wrangler d1 migrations apply`.
- [ ] Create R2 S3 access keys for the presigner and store as Wrangler secrets (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_S3_ENDPOINT`, `R2_BUCKET`).
- [ ] Set up Auth.js v5 with D1 adapter + Google OAuth; set `AUTH_TRUST_HOST=true`.
- [ ] Verify local dev with `wrangler dev` (uses `nodejs_compat` flag).

### Phase 1 — TTS + Alignment (Day 3–4)
- [ ] Build `src/services/tts.ts` — OpenAI TTS wrapper (no `speed`, validate voice list at runtime).
- [ ] Build `src/services/alignment.ts` — AssemblyAI wrapper using `/v2/upload` passthrough (stream R2 body; see §5.2).
- [ ] Split alignment into `submit` + `poll` helpers so the workflow can alternate `step.do` / `step.sleep`.
- [ ] Test both services independently with a hardcoded script.
- [ ] Build caption-JSON → Remotion `Caption[]` transformer (emit `timestampMs`, `confidence`).

### Phase 2 — Video Generation (Day 5–6)
- [ ] Pin the exact fal.ai Hailuo endpoint slug against the live model card.
- [ ] Build `src/services/video-gen.ts` with `submitVideoJob` + `pollVideoJob` (no in-function sleeps).
- [ ] Build Pexels fallback service for generic prompts (include attribution string).
- [ ] Decide default `durationStrategy` (MVP: `loop`) and document it in the README.
- [ ] Test with 5 different cosmic/mystical prompts.

### Phase 3 — Remotion Composition (Day 7–9)
- [ ] Build `remotion/ReelComposition.tsx` — single-clip + ping-pong loop + Ken-Burns zoom (§5.5).
- [ ] Validate the ping-pong approach on an actual Hailuo clip; fall back to an FFmpeg-preprocessed ping-pong MP4 inside the Trigger.dev task if needed.
- [ ] Test locally: `npx remotion render ReelComposition`.
- [ ] Pre-bundle Remotion with `npx remotion bundle` and upload to R2 / Pages; set `REMOTION_SERVE_URL`.
- [ ] Build `trigger/render-reel.ts` — `ensureBrowser`, fetch via presigned URLs, PUT final via presigned URL, HMAC-signed webhook.
- [ ] Configure Trigger.dev build extension to install Chromium dependencies.
- [ ] Test Trigger.dev task with staging presigned URLs and verify 1080×1920 output.

### Phase 4 — CF Workflow Orchestration (Day 10–12)
- [ ] Build `src/workflows/reel-workflow.ts` with `step.do` / `step.sleep` alternation, bounded poll loops, and a top-level try/catch that writes a terminal failed state.
- [ ] Build POST `/api/jobs` route — auth check, Zod validation, per-user rate limit, D1 insert, workflow dispatch.
- [ ] Build webhook handler `/api/webhooks/composition-complete` — HMAC verification, timestamp replay guard, `REEL_FLOW.sendEvent`.
- [ ] Build `/api/download/[jobId]` — ownership check, stream R2 body through the Worker.
- [ ] Test full pipeline end-to-end with `wrangler dev` + a deployed Trigger.dev staging env.

### Phase 5 — Real-time Status + UI (Day 13–15)
- [ ] Build SSE stream route `/api/status/[jobId]` with auth + ownership checks and 25 s budget (§5.8).
- [ ] Build client `EventSource` hook that auto-reconnects and halts on `complete` / `failed`.
- [ ] Build creation form UI (Tailwind + shadcn/ui) with voice/video prompt inputs and duration-strategy toggle.
- [ ] Build progress indicator component (stages: audio → captions → video → composing → done; plus failed state).
- [ ] Build download page with platform-specific export metadata.

### Phase 6 — Deploy (Day 16)
- [ ] `opennextjs-cloudflare build && wrangler deploy`.
- [ ] Configure custom domain in Cloudflare dashboard.
- [ ] Deploy Trigger.dev task: `npx trigger.dev@latest deploy` (prod env).
- [ ] Set all secrets in both Cloudflare (`wrangler secret put ...`) and Trigger.dev (env groups).
- [ ] End-to-end smoke test in production, including a forced-failure path to verify the `failed` terminal state reaches the UI.

---

## 11. Environment Variables

Secrets are stored per environment. CF-side secrets are set via `wrangler secret put ...`; Trigger.dev-side secrets via the Trigger.dev dashboard or CLI.

```
# ── Cloudflare Worker (wrangler secrets) ───────────────────────────────
# D1, R2, KV, and Workflows are accessed via native bindings — no env vars

# AI services
OPENAI_API_KEY=sk-...
ELEVENLABS_API_KEY=...              # optional premium voice tier
ASSEMBLYAI_API_KEY=...
FAL_KEY=...
PEXELS_API_KEY=...                  # free stock video fallback

# R2 S3-compatible credentials (for the presigner — NOT the binding)
R2_S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=ivoreel

# Trigger.dev
TRIGGER_SECRET_KEY=tr_...
CF_WORKER_URL=https://ivoreel.com   # for Trigger.dev → CF webhook

# Webhook signing (shared with Trigger.dev task)
WEBHOOK_SIGNING_SECRET=...          # long random string, 32+ bytes

# Auth
AUTH_SECRET=...
AUTH_TRUST_HOST=true
AUTH_GOOGLE_ID=...
AUTH_GOOGLE_SECRET=...

# ── Trigger.dev task env (mirror a subset) ─────────────────────────────
REMOTION_SERVE_URL=https://ivoreel.com/remotion/bundle
WEBHOOK_SIGNING_SECRET=...          # same value as the Worker
# No R2 creds here — Trigger.dev uses presigned URLs handed to it by the Worker
```

---

## 12. Key Implementation Notes

### Must-know constraints

1. **No `export const runtime = "edge"` anywhere.** All Next.js routes must use Node.js runtime (the default). This is the single most common error when deploying to OpenNext/CF Workers.

2. **No persistent DB connections.** Cloudflare Workers cannot reuse connection pools between requests. Always create DB clients inside request context, not globally.

3. **Remotion MUST run in Trigger.dev.** It cannot run in Workers under any circumstance. The 10MB bundle limit alone blocks it; Chromium adds another hard wall.

4. **The R2 Workers binding does NOT expose `createSignedUrl`.** For Trigger.dev access, use the AWS S3 presigner against the R2 S3 endpoint with account-scoped keys (§5.9). For user downloads, stream the object body through the Worker instead.

5. **CF Workflows state is durable.** If any step fails, Workflows retries only that step — it does not re-run the entire pipeline. This means you will not be billed twice for already-completed TTS or video generation.

6. **`step.sleep` is a workflow-level primitive.** Never call it inside a `step.do` closure. Use the alternating `submit` → `step.sleep` → `poll` pattern in §5.4 for anything that needs to wait on an external job.

7. **Always wrap `run()` in try/catch.** Without a terminal `failed` record in D1 + KV, the SSE loop on the client will hang until the browser gives up. See §5.4.

8. **SSE in Workers is short-lived.** Workers cap wall-clock at 30 s (default) / 5 min (paid `cpu_ms`). The SSE handler in §5.8 closes after ~25 s and relies on `EventSource` auto-reconnect. Do not write infinite-loop streams.

9. **KV consistency.** CF KV has eventual consistency (up to ~60 s across regions). For job status this is acceptable; do not rely on it for correctness-critical reads.

10. **Caption animation requires Remotion.** FFmpeg ASS subtitles can do color-based word highlighting but cannot do bounce/scale/pop animations. Remotion is non-negotiable if you want TikTok-style captions.

11. **Narration always outlives the 6-second background clip.** You must pick a duration strategy (loop, stitch, or stock) — see §5.3. The default is loop.

12. **Rate-limit `POST /api/jobs` per user.** A single buggy client can burn hundreds of dollars of fal.ai credits in minutes. Enforce concurrent-jobs and per-hour caps in D1 before dispatching the workflow.

13. **The composition-complete webhook must be HMAC-verified.** Without it, anyone can mark jobs complete and point `output_key` at attacker-controlled R2 keys.

14. **`@opennextjs/cloudflare` adapter uses `nodejs_compat` flag.** This flag must be set in `wrangler.jsonc` and the compatibility date must be `2024-09-23` or later. Set it to today's date.

15. **OpenNext + Next.js 15.4+ instrumentation hook.** Historically had a known issue; verify against current OpenNext releases before pinning. Downgrade to 15.3 if you hit `Error: An error occurred while loading the instrumentation hook`.

16. **Windows users:** Develop using WSL. OpenNext on Windows has limited support. All CI/CD must run on Linux (GitHub Actions is fine).

---

*Document version: 1.1 | Stack: Next.js 15 / Cloudflare Workers (OpenNext) / CF Workflows / Trigger.dev (Remotion) / fal.ai Hailuo / OpenAI TTS / AssemblyAI / Cloudflare R2 / D1 / KV*
