interface BearFaceProps {
  size?: number;
  /** Kept for call-site API compatibility; the mascot image is fixed-color. */
  variant?: 'sage' | 'primary' | 'accent' | 'brown';
}

/**
 * Wherebear mascot — the detective-bear logo (public/logo.png). The white matte
 * is blended away with `multiply` so it sits cleanly on the app's cream / light
 * surfaces without a visible white box. For the animated version see AnimatedBear.
 */
export default function BearFace({ size = 56 }: BearFaceProps) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/bear-flat.png"
      alt="Wherebear"
      width={size}
      height={size}
      style={{ display: 'block', objectFit: 'contain', mixBlendMode: 'multiply' }}
    />
  );
}
