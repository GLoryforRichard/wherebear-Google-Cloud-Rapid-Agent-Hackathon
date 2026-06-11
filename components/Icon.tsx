interface IconProps {
  name: string;
  size?: number;
  style?: React.CSSProperties;
}

const ks = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export default function Icon({ name, size = 24, style }: IconProps) {
  const s = { width: size, height: size, ...style };
  switch (name) {
    case 'camera': return <svg viewBox="0 0 24 24" style={s}><path {...ks} d="M4 8h3l2-2.5h6L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13" r="3.8" {...ks}/></svg>;
    case 'search': return <svg viewBox="0 0 24 24" style={s}><circle cx="11" cy="11" r="6.5" {...ks}/><path {...ks} d="m16 16 4.5 4.5"/></svg>;
    case 'image': return <svg viewBox="0 0 24 24" style={s}><rect x="3" y="4.5" width="18" height="15" rx="2.5" {...ks}/><circle cx="9" cy="10.5" r="1.6" {...ks}/><path {...ks} d="m4 17 4.5-4.5 4 4 3-3L20 17"/></svg>;
    case 'chevron-right': return <svg viewBox="0 0 24 24" style={s}><path {...ks} d="m9 6 6 6-6 6"/></svg>;
    case 'chevron-down': return <svg viewBox="0 0 24 24" style={s}><path {...ks} d="m6 9 6 6 6-6"/></svg>;
    case 'back': return <svg viewBox="0 0 24 24" style={s}><path {...ks} d="M15 5 8 12l7 7"/></svg>;
    case 'check': return <svg viewBox="0 0 24 24" style={s}><path {...ks} d="m5 12.5 4.5 4.5L19 7.5"/></svg>;
    case 'x': return <svg viewBox="0 0 24 24" style={s}><path {...ks} d="m6 6 12 12M18 6 6 18"/></svg>;
    case 'x-circle': return <svg viewBox="0 0 24 24" style={s}><circle cx="12" cy="12" r="9" fill="#b9c1b6" stroke="none"/><path stroke="#fff" strokeWidth="2" strokeLinecap="round" d="m9 9 6 6M15 9l-6 6"/></svg>;
    case 'pin': return <svg viewBox="0 0 24 24" style={s}><path {...ks} d="M12 21s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12Z"/><circle cx="12" cy="9.5" r="2.6" {...ks}/></svg>;
    case 'home': return <svg viewBox="0 0 24 24" style={s}><path {...ks} d="M4 11.5 12 4l8 7.5V20a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1Z"/></svg>;
    case 'clock': return <svg viewBox="0 0 24 24" style={s}><circle cx="12" cy="12" r="8.5" {...ks}/><path {...ks} d="M12 7.5V12l3 2"/></svg>;
    case 'settings': return <svg viewBox="0 0 24 24" style={s}><circle cx="12" cy="12" r="3" {...ks}/><path {...ks} d="M19.4 14.5a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V20a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H4a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H10a1.7 1.7 0 0 0 1-1.5V4a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V10a1.7 1.7 0 0 0 1.5 1H20a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>;
    case 'bars': return <svg viewBox="0 0 24 24" style={s}><path {...ks} d="M5 18v-5M12 18V9M19 18V5"/></svg>;
    case 'sparkle': return <svg viewBox="0 0 24 24" style={s}><path {...ks} d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6Z" fill="currentColor"/></svg>;
    case 'dots': return <svg viewBox="0 0 24 24" style={s}><circle cx="6.5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="17.5" cy="12" r="1.6" fill="currentColor"/></svg>;
    case 'map': return <svg viewBox="0 0 24 24" style={s}><path {...ks} d="M3 7.5 9 5l6 2.5 6-2.5v12L15 19.5 9 17l-6 2.5Z"/><path {...ks} d="M9 5v12M15 7.5v12"/></svg>;
    case 'mic': return <svg viewBox="0 0 24 24" style={s}><rect x="9" y="2.5" width="6" height="11.5" rx="3" {...ks}/><path {...ks} d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/></svg>;
    default: return null;
  }
}
