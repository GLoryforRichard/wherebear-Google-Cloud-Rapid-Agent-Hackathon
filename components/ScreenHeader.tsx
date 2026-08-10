import { C, FONT } from '@/lib/theme';
import Icon from './Icon';
import LanguageToggle from './LanguageToggle';

interface ScreenHeaderProps {
  title: string;
  onBack: () => void;
}

export default function ScreenHeader({ title, onBack }: ScreenHeaderProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0 16px', position: 'relative' }}>
      <button onClick={onBack} style={{
        width: 38, height: 38, borderRadius: 19, background: C.white,
        border: `2px solid ${C.border}`, boxShadow: '2px 2px 0 #111111',
        display: 'flex', alignItems: 'center',
        justifyContent: 'center', color: C.text, cursor: 'pointer', flexShrink: 0,
      }}>
        <Icon name="back" size={20} />
      </button>
      <div style={{ flex: 1, textAlign: 'center', fontSize: 19, fontWeight: 800, color: C.text, letterSpacing: -0.3, fontFamily: FONT }}>{title}</div>
      <LanguageToggle />
    </div>
  );
}
