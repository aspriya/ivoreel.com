/**
 * Remotion composition for the 1080×1920 vertical Reel.
 *
 * Strategy A (default): the background clip (~6s) is ping-pong looped with
 * a slow Ken-Burns zoom so it stays alive for the full narration duration.
 */
import React from "react";
import {
  AbsoluteFill,
  Audio,
  Video,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
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
  audioFile,
  backgroundVideoFile,
  captions,
  durationMs,
  captionStyle,
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
  const currentPage = pages.find(
    (p) => p.startMs <= currentMs && p.endMs > currentMs,
  );

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <AbsoluteFill style={{ transform: `scale(${zoom})` }}>
        <Video
          src={backgroundVideoFile}
          startFrom={Math.floor(clipTimeSec * fps)}
          muted
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </AbsoluteFill>
      <Audio src={audioFile} />
      {currentPage && (
        <AbsoluteFill
          style={{
            justifyContent: "flex-end",
            paddingBottom: 120,
            alignItems: "center",
          }}
        >
          <div
            style={{
              textAlign: "center",
              padding: "12px 24px",
              borderRadius: 12,
              backgroundColor: captionStyle.backgroundColor,
            }}
          >
            {currentPage.tokens.map((token, i) => (
              <span
                key={i}
                style={{
                  fontSize: captionStyle.fontSize,
                  fontFamily: captionStyle.fontFamily,
                  fontWeight: 800,
                  color: token.isActive
                    ? captionStyle.activeColor
                    : captionStyle.inactiveColor,
                  marginRight: 8,
                  display: "inline-block",
                  transform: token.isActive ? "scale(1.15)" : "scale(1)",
                  transition: "transform 0.1s",
                }}
              >
                {token.text}
              </span>
            ))}
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};
