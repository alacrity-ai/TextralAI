import { type HTMLAttributes, useState } from 'react';
import { colors, radii, spacing, shadows } from '../../styles/tokens.js';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  hover?: boolean;
  borderColor?: string;
  ruled?: boolean;
}

export function Card({ hover, borderColor, ruled, children, style, ...props }: CardProps) {
  const [isHover, setIsHover] = useState(false);
  const baseBorder = borderColor || colors.border;

  return (
    <div
      onMouseEnter={hover ? () => setIsHover(true) : undefined}
      onMouseLeave={hover ? () => setIsHover(false) : undefined}
      style={{
        position: 'relative',
        background: colors.bgCard,
        border: `1px solid ${hover && isHover ? colors.borderEmphasis : baseBorder}`,
        borderRadius: radii.lg,
        padding: spacing.lg,
        cursor: hover ? 'pointer' : undefined,
        transition: hover
          ? 'border-color 220ms ease, transform 220ms cubic-bezier(0.2,0.6,0.2,1), box-shadow 220ms ease'
          : undefined,
        transform: hover && isHover ? 'translateY(-2px)' : 'translateY(0)',
        boxShadow: hover && isHover ? shadows.card : '0 1px 0 rgba(0,0,0,0.25)',
        ...style,
      }}
      {...props}
    >
      {ruled && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: spacing.lg,
            right: spacing.lg,
            height: 1,
            background: `linear-gradient(to right, ${colors.primary}, transparent)`,
            opacity: 0.5,
          }}
        />
      )}
      {children}
    </div>
  );
}
