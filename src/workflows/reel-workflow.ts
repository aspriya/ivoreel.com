/**
 * CF Workflow that orchestrates the AI pipeline for a single Reel job.
 *
 * Patterns:
 *   - `step.sleep` is only called at the workflow level — never inside a
 *     step.do() closure. Polling is `step.do(submit)` -> step.sleep ->
 *     `step.do(poll)` alternation with a bounded MAX_POLL_ATTEMPTS.
 *   - A top-level try/catch writes a terminal `failed` record to D1 + KV
 *     so the SSE client stops waiting.
 */
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type { CaptionsDoc, ReelJobParams } from "@/src/types";
import { generateVoiceover } from "@/src/services/tts";
import { submitAlignment, pollAlignment } from "@/src/services/alignment";
import { submitVideoJob, pollVideoJob } from "@/src/services/video-gen";
import { presignGet, presignPut } from "@/src/lib/r2-presign";

const MAX_POLL_ATTEMPTS = 60;

export class ReelWorkflow extends WorkflowEntrypoint<CloudflareEnv, ReelJobParams> {
  async run(event: WorkflowEvent<ReelJobParams>, step: WorkflowStep) {
    const { jobId, narrationText, voiceStylePrompt, videoPrompt, voiceName } =
      event.payload;

    try {
      // Step 1 — Voiceover
      const audioKey = await step.do("generate-audio", async () => {
        const buf = await generateVoiceover(
          { narrationText, voiceStylePrompt, voice: voiceName },
          this.env,
        );
        const key = `jobs/${jobId}/audio.mp3`;
        await this.env.REEL_BUCKET.put(key, buf);
        await this.env.JOB_STATUS.put(
          jobId,
          JSON.stringify({ stage: "audio_done", progress: 25 }),
        );
        return key;
      });

      // Step 2 — Alignment (submit + bounded poll + store)
      const transcriptId = await step.do("submit-alignment", () =>
        submitAlignment(audioKey, jobId, this.env),
      );

      let captions: CaptionsDoc | null = null;
      for (let i = 0; i < MAX_POLL_ATTEMPTS && !captions; i++) {
        await step.sleep(`wait-alignment-${i}`, "3 seconds");
        captions = await step.do(`poll-alignment-${i}`, () =>
          pollAlignment(transcriptId, this.env),
        );
      }
      if (!captions) throw new Error("alignment timed out");

      const captionsKey = await step.do("store-captions", async () => {
        const key = `jobs/${jobId}/captions.json`;
        await this.env.REEL_BUCKET.put(key, JSON.stringify(captions));
        await this.env.JOB_STATUS.put(
          jobId,
          JSON.stringify({ stage: "captions_done", progress: 50 }),
        );
        return key;
      });

      // Step 3 — Video (submit + bounded poll + download to R2)
      const videoRequestId = await step.do("submit-video", () =>
        submitVideoJob(this.env, videoPrompt),
      );

      let videoUrl: string | null = null;
      for (let i = 0; i < MAX_POLL_ATTEMPTS && !videoUrl; i++) {
        await step.sleep(`wait-video-${i}`, "5 seconds");
        const res = await step.do(`poll-video-${i}`, () =>
          pollVideoJob(this.env, videoRequestId),
        );
        if (res.done && res.url) videoUrl = res.url;
      }
      if (!videoUrl) throw new Error("video generation timed out");

      const videoKey = await step.do("store-video", async () => {
        const res = await fetch(videoUrl!);
        if (!res.ok || !res.body) {
          throw new Error(`video download failed: ${res.status}`);
        }
        const key = `jobs/${jobId}/background.mp4`;
        await this.env.REEL_BUCKET.put(key, res.body);
        await this.env.JOB_STATUS.put(
          jobId,
          JSON.stringify({ stage: "video_done", progress: 75 }),
        );
        return key;
      });

      // Step 4 — Dispatch Remotion composition to Trigger.dev with presigned URLs
      await step.do("trigger-composition", async () => {
        const [audioUrl, captionsUrl, videoDlUrl, uploadUrl] = await Promise.all([
          presignGet(this.env, audioKey, 3600),
          presignGet(this.env, captionsKey, 3600),
          presignGet(this.env, videoKey, 3600),
          presignPut(this.env, `jobs/${jobId}/final_reel.mp4`, 3600),
        ]);

        const res = await fetch(
          "https://api.trigger.dev/api/v1/tasks/render-reel/trigger",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.env.TRIGGER_SECRET_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              payload: {
                jobId,
                audioUrl,
                captionsUrl,
                videoUrl: videoDlUrl,
                uploadUrl,
                webhookUrl: `${this.env.CF_WORKER_URL}/api/webhooks/composition-complete`,
                durationStrategy: event.payload.durationStrategy,
              },
            }),
          },
        );
        if (!res.ok) {
          throw new Error(`trigger.dev dispatch failed: ${res.status} ${await res.text()}`);
        }
        await this.env.JOB_STATUS.put(
          jobId,
          JSON.stringify({ stage: "composing", progress: 80 }),
        );
      });

      // Step 5 — Wait for Trigger.dev webhook to signal completion
      const { finalKey } = await step.waitForEvent<{ finalKey: string }>(
        "composition-complete",
        { type: "composition-complete", timeout: "15 minutes" },
      );

      await step.do("mark-complete", async () => {
        await this.env.DB.prepare(
          "UPDATE jobs SET status='complete', output_key=?, completed_at=? WHERE id=?",
        )
          .bind(finalKey, Date.now(), jobId)
          .run();
        await this.env.JOB_STATUS.put(
          jobId,
          JSON.stringify({ stage: "complete", progress: 100, outputKey: finalKey }),
        );
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await step.do("mark-failed", async () => {
        await this.env.DB.prepare(
          "UPDATE jobs SET status='failed', completed_at=? WHERE id=?",
        )
          .bind(Date.now(), jobId)
          .run();
        await this.env.JOB_STATUS.put(
          jobId,
          JSON.stringify({ stage: "failed", progress: 0, error: message }),
          { expirationTtl: 60 * 60 * 24 },
        );
      });
      throw err;
    }
  }
}
