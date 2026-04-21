/**
 * OpenAI TTS via the `/v1/audio/speech` endpoint using `gpt-4o-mini-tts`.
 *
 * Note: `gpt-4o-mini-tts` does NOT accept the legacy `speed` parameter that
 * `tts-1` / `tts-1-hd` support. Use the `instructions` field to control pacing.
 * The voice list evolves — treat it as free-form and validate at runtime.
 */

export interface TtsInput {
  narrationText: string;
  voiceStylePrompt: string;
  voice?: string; // default: "nova"
}

export async function generateVoiceover(
  input: TtsInput,
  env: CloudflareEnv,
): Promise<ArrayBuffer> {
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      input: input.narrationText,
      voice: input.voice ?? "nova",
      instructions: input.voiceStylePrompt,
      response_format: "mp3",
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`openai-tts: ${res.status} ${text}`);
  }
  return res.arrayBuffer();
}
