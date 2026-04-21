/**
 * Trigger.dev task that runs Remotion composition.
 *
 * Runs in a container with Chromium installed. Receives presigned URLs from
 * the CF Workflow, downloads assets, renders, uploads final MP4, and signals
 * completion via HMAC-signed webhook.
 */
import { task } from "@trigger.dev/sdk/v3";
import { renderMedia, selectComposition, ensureBrowser } from "@remotion/renderer";
import { createHmac } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const renderReel = task({
  id: "render-reel",
  maxDuration: 600, // 10 minutes
  run: async (payload: {
    jobId: string;
    audioUrl: string;
    captionsUrl: string;
    videoUrl: string; // presigned GET for the background clip
    uploadUrl: string; // presigned PUT for final_reel.mp4
    webhookUrl: string;
    durationStrategy?: "loop" | "stitch";
  }) => {
    const { jobId, audioUrl, captionsUrl, videoUrl, uploadUrl, webhookUrl } =
      payload;

    await ensureBrowser();

    // 1. Download assets to /tmp
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "reel-"));
    const audioPath = path.join(tmpDir, "audio.mp3");
    const videoPath = path.join(tmpDir, "background.mp4");

    const [audioRes, captionsRes, videoRes] = await Promise.all([
      fetch(audioUrl),
      fetch(captionsUrl),
      fetch(videoUrl),
    ]);
    for (const [name, res] of [
      ["audio", audioRes],
      ["captions", captionsRes],
      ["video", videoRes],
    ] as const) {
      if (!res.ok) throw new Error(`fetch ${name} failed: ${res.status}`);
    }

    await fs.writeFile(audioPath, Buffer.from(await audioRes.arrayBuffer()));
    await fs.writeFile(videoPath, Buffer.from(await videoRes.arrayBuffer()));
    const captionsJson = (await captionsRes.json()) as {
      words: unknown[];
      durationMs: number;
    };

    // 2. Render with Remotion
    const serveUrl = process.env.REMOTION_SERVE_URL!;
    const durationMs: number = captionsJson.durationMs ?? 30000;
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
      composition: {
        ...composition,
        durationInFrames,
        fps,
        width: 1080,
        height: 1920,
      },
      serveUrl,
      codec: "h264",
      outputLocation,
      imageFormat: "jpeg",
      jpegQuality: 80,
    });

    // 3. Upload final MP4 via presigned PUT
    const finalBuffer = await fs.readFile(outputLocation);
    const putRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "video/mp4" },
      body: finalBuffer,
    });
    if (!putRes.ok) {
      throw new Error(`final upload failed: ${putRes.status}`);
    }

    // 4. HMAC-signed webhook
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
      headers: {
        "Content-Type": "application/json",
        "X-Signature": signature,
      },
      body,
    });
    if (!webhookRes.ok) {
      throw new Error(`webhook failed: ${webhookRes.status}`);
    }

    // 5. Cleanup
    await fs.rm(tmpDir, { recursive: true, force: true });
  },
});
