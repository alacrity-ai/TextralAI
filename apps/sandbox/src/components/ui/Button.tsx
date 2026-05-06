import { type ButtonHTMLAttributes, useState } from 'react';
import { colors, radii } from '../../styles/tokens.js';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  loading?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

const variants = {
  primary: {
    background: colors.primary,
    color: '#1a1208',
    border: '1px solid transparent',
    hoverBg: colors.primaryHover,
    hoverColor: '#1a1208',
    activeBg: colors.primaryActive,
  },
  secondary: {
    background: 'transparent',
    color: colors.textSecondary,
    border: `1px solid ${colors.borderEmphasis}`,
    hoverBg: colors.bgElevated,
    hoverColor: colors.textPrimary,
    activeBg: colors.bgCard,
  },
  danger: {
    background: 'transparent',
    color: colors.danger,
    border: `1px solid ${colors.danger}`,
    hoverBg: 'rgba(166, 64, 56, 0.12)',
    hoverColor: '#c4584d',
    activeBg: 'rgba(166, 64, 56, 0.20)',
  },
  ghost: {
    background: 'transparent',
    color: colors.textSecondary,
    border: '1px solid transparent',
    hoverBg: 'rgba(201, 169, 97, 0.08)',
    hoverColor: colors.accent,
    activeBg: 'rgba(201, 169, 97, 0.16)',
  },
};

const sizes = {
  sm: { padding: '4px 12px', fontSize: 12, letterSpacing: '0.04em' },
  md: { padding: '8px 18px', fontSize: 13, letterSpacing: '0.04em' },
  lg: { padding: '12px 26px', fontSize: 14, letterSpacing: '0.05em' },
};

export function Button({
  variant = 'primary',
  loading,
  size = 'md',
  disabled,
  children,
  style,
  ...props
}: ButtonProps) {
  const v = variants[variant];
  const s = sizes[size];
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);

  const bg =
    disabled || loading ? v.background : active ? v.activeBg : hover ? v.hoverBg : v.background;
  const color = disabled || loading ? v.color : hover ? v.hoverColor : v.color;

  return (
    <button
      disabled={disabled || loading}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setActive(false);
      }}
      onMouseDown={() => setActive(true)}
      onMouseUp={() => setActive(false)}
      style={{
        background: bg,
        color,
        border: v.border,
        borderRadius: radii.md,
        padding: s.padding,
        fontSize: s.fontSize,
        fontFamily: "'DM Sans', sans-serif",
        fontWeight: 500,
        letterSpacing: s.letterSpacing,
        cursor: disabled || loading ? 'not-allowed' : 'pointer',
        opacity: disabled || loading ? 0.45 : 1,
        transition:
          'background 180ms ease, color 180ms ease, transform 100ms ease, box-shadow 200ms ease',
        transform: active && !disabled ? 'translateY(1px)' : 'translateY(0)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        boxShadow:
          variant === 'primary' && !disabled
            ? hover
              ? '0 4px 16px -6px rgba(201, 169, 97, 0.45)'
              : '0 1px 0 rgba(0,0,0,0.3)'
            : 'none',
        ...style,
      }}
      {...props}
    >
      {loading && <InlineSpinner size={size === 'sm' ? 12 : 14} />}
      {children}
    </button>
  );
}

function InlineSpinner({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={{ animation: 'enrichment-spin 900ms linear infinite' }}
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="2.5"
        fill="none"
        opacity="0.25"
      />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="2.5"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}
