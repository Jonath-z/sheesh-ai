import { Composition } from "remotion";
import { TitleCard, titleCardSchema } from "./TitleCard";

export const Root: React.FC = () => {
  return (
    <Composition
      id="TitleCard"
      component={TitleCard}
      schema={titleCardSchema}
      durationInFrames={90}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={{
        text: "Untitled",
        subtitle: "",
        theme: "minimal" as const,
        kind: "intro" as const,
        width: 1920,
        height: 1080,
        duration_s: 3,
        fps: 30,
      }}
      calculateMetadata={({ props }) => ({
        width: props.width,
        height: props.height,
        durationInFrames: Math.max(15, Math.round(props.duration_s * props.fps)),
        fps: props.fps,
      })}
    />
  );
};
