'use client';

interface AnimatedBearProps {
  size?: number;
}

/**
 * Animated Wherebear mascot — a short looping idle clip (public/bear-idle.mp4,
 * generated from the logo). The clip's white background is blended away with
 * `multiply` so it sits on the cream surface like the static <BearFace>. Muted +
 * autoplay + playsInline so it loops silently inline on mobile.
 */
export default function AnimatedBear({ size = 96 }: AnimatedBearProps) {
  return (
    <video
      src="/bear-idle.mp4"
      autoPlay
      loop
      muted
      playsInline
      aria-hidden
      style={{
        width: size,
        height: size,
        objectFit: 'cover',
        display: 'block',
        mixBlendMode: 'multiply',
        pointerEvents: 'none',
      }}
    />
  );
}
