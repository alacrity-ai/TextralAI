import { colors, radii } from '../../styles/tokens.js';

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  borderRadius?: number;
}

export function Skeleton({ width = '100%', height = 16, borderRadius = radii.md }: SkeletonProps) {
  return (
    <div
      style={{
        width,
        height,
        borderRadius,
        background: `linear-gradient(90deg,
          ${colors.bgElevated} 25%,
          rgba(201, 169, 97, 0.10) 50%,
          ${colors.bgElevated} 75%
        )`,
        backgroundSize: '200% 100%',
        animation: 'shimmer 1.8s ease-in-out infinite',
      }}
    />
  );
}

export function SkeletonCard() {
  return (
    <div
      style={{
        background: colors.bgCard,
        border: `1px solid ${colors.border}`,
        borderRadius: radii.lg,
        padding: 24,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <Skeleton height={22} width="65%" />
      <Skeleton height={12} width="40%" />
      <div style={{ height: 4 }} />
      <Skeleton height={10} width="55%" />
      <Skeleton height={10} width="35%" />
    </div>
  );
}
