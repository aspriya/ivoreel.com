import { Composition } from "remotion";
import { ReelComposition } from "./ReelComposition";
import type { Caption } from "@remotion/captions";

export const RemotionRoot: React.FC = () => {
  // Default props for preview; real values are passed via inputProps at render time
  const defaultProps = {
    audioFile: "",
    backgroundVideoFile: "",
    captions: [] as Caption[],
    durationMs: 30000,
    durationStrategy: "loop" as const,
    captionStyle: {
      fontFamily: "Montserrat",
      fontSize: 72,
      activeColor: "#FFD700",
      inactiveColor: "#FFFFFF",
      backgroundColor: "rgba(0,0,0,0.4)",
      animation: "bounce" as const,
    },
  };

  return (
    <>
      <Composition
        id="ReelComposition"
        component={ReelComposition as unknown as React.ComponentType<Record<string, unknown>>}
        durationInFrames={900}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={defaultProps}
      />
    </>
  );
};
