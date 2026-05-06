import { type InputHTMLAttributes, useState } from 'react';
import { colors, radii } from '../../styles/tokens.js';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export function Input({ label, error, style, onFocus, onBlur, ...props }: InputProps) {
  const [focused, setFocused] = useState(false);
  const borderColor = error ? colors.danger : focused ? colors.primary : colors.border;

  return (
    <div>
      {label && (
        <label
          style={{
            display: 'block',
            marginBottom: 7,
            fontSize: 11,
            color: colors.textSecondary,
            fontWeight: 500,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
          }}
        >
          {label}
        </label>
      )}
      <input
        onFocus={(e) => {
          setFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          onBlur?.(e);
        }}
        style={{
          width: '100%',
          padding: '11px 14px',
          background: colors.bgInput,
          color: colors.textPrimary,
          border: `1px solid ${borderColor}`,
          borderRadius: radii.md,
          fontSize: 14,
          fontFamily: "'DM Sans', sans-serif",
          letterSpacing: '-0.005em',
          outline: 'none',
          transition: 'border-color 200ms ease, box-shadow 200ms ease, background 200ms ease',
          boxShadow: focused
            ? '0 0 0 3px rgba(201, 169, 97, 0.10)'
            : 'inset 0 1px 0 rgba(0,0,0,0.2)',
          ...style,
        }}
        {...props}
      />
      {error && (
        <p
          style={{
            marginTop: 6,
            fontSize: 12,
            color: colors.danger,
            fontFamily: "'Fraunces', serif",
            fontStyle: 'italic',
          }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
