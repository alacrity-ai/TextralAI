import { useState } from 'react';
import { colors, radii } from '../../styles/tokens.js';

interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  style?: React.CSSProperties;
}

export function SearchInput({ value, onChange, placeholder = 'Search…', autoFocus, style }: Props) {
  const [focused, setFocused] = useState(false);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: colors.bgInput,
        border: `1px solid ${focused ? colors.primary : colors.border}`,
        borderRadius: radii.md,
        padding: '7px 12px',
        minWidth: 240,
        transition: 'border-color 200ms ease, box-shadow 200ms ease',
        boxShadow: focused
          ? '0 0 0 3px rgba(201, 169, 97, 0.10)'
          : 'inset 0 1px 0 rgba(0,0,0,0.18)',
        ...style,
      }}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke={focused ? colors.primary : colors.textMuted}
        strokeWidth="2"
        style={{ transition: 'stroke 200ms ease', flexShrink: 0 }}
      >
        <circle cx="11" cy="11" r="7" />
        <path d="M21 21l-4.3-4.3" strokeLinecap="round" />
      </svg>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        style={{
          flex: 1,
          background: 'transparent',
          border: 'none',
          outline: 'none',
          color: colors.textPrimary,
          fontSize: 13,
          fontFamily: "'DM Sans', sans-serif",
          letterSpacing: '-0.005em',
        }}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          style={{
            background: 'transparent',
            border: 'none',
            color: colors.textMuted,
            cursor: 'pointer',
            padding: 0,
            fontSize: 16,
            lineHeight: 1,
            transition: 'color 150ms ease',
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.color = colors.textPrimary;
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.color = colors.textMuted;
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}
