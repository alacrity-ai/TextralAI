import { type ReactNode } from 'react';
import { colors, spacing, fonts } from '../../styles/tokens.js';

interface Props {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: Props) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: spacing.md,
        padding: `${spacing.xxl}px ${spacing.lg}px ${spacing.xl}px`,
        color: colors.textMuted,
        textAlign: 'center',
        position: 'relative',
      }}
    >
      {icon && (
        <div style={{ color: colors.primary, marginBottom: 4, opacity: 0.55, fontSize: 28 }}>
          {icon}
        </div>
      )}
      <div
        aria-hidden
        style={{
          width: 28,
          height: 1,
          background: `linear-gradient(to right, transparent, ${colors.primary}, transparent)`,
          opacity: 0.55,
        }}
      />
      <h3
        style={{
          margin: 0,
          color: colors.textPrimary,
          fontFamily: fonts.display,
          fontSize: 26,
          fontWeight: 400,
          letterSpacing: '-0.02em',
          fontVariationSettings: '"opsz" 144, "SOFT" 30',
        }}
      >
        {title}
      </h3>
      {description && (
        <p
          style={{
            margin: 0,
            fontSize: 14,
            maxWidth: 440,
            color: colors.textSecondary,
            fontFamily: fonts.serif,
            fontStyle: 'italic',
            fontVariationSettings: '"opsz" 14, "SOFT" 80',
            lineHeight: 1.55,
          }}
        >
          {description}
        </p>
      )}
      {action && <div style={{ marginTop: spacing.sm }}>{action}</div>}
    </div>
  );
}
