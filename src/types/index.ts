/**
 * Shared types used across Worker code, services, and the Workflow.
 */

export type JobStage =
  | "queued"
  | "audio_done"
  | "captions_done"
  | "video_done"
  | "composing"
  | "complete"
  | "failed";

export interface JobStatusBase {
  stage: JobStage;
  progress: number;
}

export interface JobStatusComplete extends JobStatusBase {
  stage: "complete";
  progress: 100;
  outputKey: string;
}

export interface JobStatusFailed extends JobStatusBase {
  stage: "failed";
  error: string;
}

export type JobStatus = JobStatusBase | JobStatusComplete | JobStatusFailed;

export type DurationStrategy = "loop" | "stitch" | "stock";

export interface ReelJobParams {
  jobId: string;
  userId: string;
  narrationText: string;
  voiceStylePrompt: string;
  videoPrompt: string;
  voiceProvider: "openai" | "elevenlabs";
  voiceName?: string;
  platform: "facebook" | "tiktok" | "youtube_shorts" | "all";
  durationStrategy: DurationStrategy;
}

export interface CaptionWord {
  text: string;
  startMs: number;
  endMs: number;
  timestampMs: number;
  confidence: number;
}

export interface CaptionsDoc {
  words: CaptionWord[];
  durationMs: number;
}
