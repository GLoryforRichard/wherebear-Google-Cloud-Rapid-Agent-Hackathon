interface PhotoPlaceholderProps {
  label?: string;
  height?: number;
  tone?: 'sage' | 'nori' | 'warm' | 'coral' | 'sky';
  radius?: number;
}

const palettes = {
  sage: { a: '#cfdcc6', b: '#c0d1b5', text: '#3f5a3a' },
  nori: { a: '#2a3a2a', b: '#1f2c1f', text: '#cbd6c5' },
  warm: { a: '#e7d9c2', b: '#d9c8ad', text: '#5a4a30' },
  coral: { a: '#f0c6a8', b: '#e5b08e', text: '#6e3a1f' },
  sky: { a: '#c8d8de', b: '#b3c6cd', text: '#2c4a55' },
};

export default function PhotoPlaceholder({ label = 'photo', height = 220, tone = 'sage', radius = 18 }: PhotoPlaceholderProps) {
  const p = palettes[tone];
  return (
    <div style={{
      width: '100%',
      height,
      borderRadius: radius,
      overflow: 'hidden',
      background: `repeating-linear-gradient(135deg, ${p.a} 0 14px, ${p.b} 14px 28px)`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      <div style={{
        fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
        fontSize: 11,
        letterSpacing: 0.5,
        color: p.text,
        background: 'rgba(255,255,255,0.55)',
        padding: '5px 10px',
        borderRadius: 6,
        textTransform: 'uppercase',
      }}>{label}</div>
    </div>
  );
}
