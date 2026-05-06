import { colors } from '../../styles/tokens.js';

interface BadgeProps {
  variant?: 'success' | 'warning' | 'danger' | 'info' | 'neutral';
  children: React.ReactNode;
}

const variantStyles = {
  success: { color: '#a8b977', border: 'rgba(168, 185, 119, 0.35)', dot: '#a8b977' },
  warning: { color: '#d6b87a', border: 'rgba(214, 184, 122, 0.35)', dot: '#d6b87a' },
  danger: { color: '#c47668', border: 'rgba(196, 118, 104, 0.40)', dot: '#c47668' },
  info: { color: colors.accent, border: 'rgba(201, 169, 97, 0.35)', dot: colors.primary },
  neutral: { color: colors.textMuted, border: colors.border, dot: colors.textMuted },
};

export function Badge({ variant = 'neutral', children }: BadgeProps) {
  const s = variantStyles[variant];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 9px 2px 8px',
        fontSize: 10,
        fontFamily: "'DM Sans', sans-serif",
        fontWeight: 500,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        borderRadius: 999,
        background: 'transparent',
        color: s.color,
        border: `1px solid ${s.border}`,
        lineHeight: 1.6,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 5,
          height: 5,
          borderRadius: '50%',
          background: s.dot,
          flexShrink: 0,
          opacity: 0.9,
        }}
      />
      {children}
    </span>
  );
}
