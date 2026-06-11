import { C, FONT } from '@/lib/theme';
import Icon from './Icon';

type Tab = 'home' | 'history' | 'settings';

interface TabBarProps {
  active: Tab;
  onChange: (tab: Tab) => void;
}

const tabs = [
  { id: 'home' as Tab, label: 'Home', icon: 'home' },
  { id: 'history' as Tab, label: 'History', icon: 'clock' },
  { id: 'settings' as Tab, label: 'Settings', icon: 'settings' },
];

export default function TabBar({ active, onChange }: TabBarProps) {
  return (
    <div style={{
      position: 'fixed',
      left: '50%',
      transform: 'translateX(-50%)',
      bottom: 24,
      width: 'min(390px, calc(100vw - 32px))',
      background: C.white,
      borderRadius: 28,
      padding: '10px 8px',
      display: 'grid',
      gridTemplateColumns: 'repeat(3,1fr)',
      boxShadow: '0 4px 18px rgba(20,40,20,0.08), 0 0 0 1px rgba(20,40,20,0.04)',
      zIndex: 30,
    }}>
      {tabs.map(t => {
        const a = t.id === active;
        return (
          <button key={t.id} onClick={() => onChange(t.id)} style={{
            border: 'none',
            background: a ? C.primarySofter : 'transparent',
            color: a ? C.primaryDark : C.textMuted,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 2,
            padding: '8px 0',
            borderRadius: 20,
            cursor: 'pointer',
            fontFamily: FONT,
            fontWeight: a ? 600 : 500,
            fontSize: 12,
          }}>
            <Icon name={t.icon} size={22} />
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
