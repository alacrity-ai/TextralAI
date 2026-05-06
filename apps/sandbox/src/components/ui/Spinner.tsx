import { colors } from '../../styles/tokens.js';

interface SpinnerProps {
  size?: number;
  color?: string;
}

export function Spinner({ size = 24, color = colors.primary }: SpinnerProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={{ animation: 'enrichment-spin 900ms linear infinite' }}
    >
      <circle cx="12" cy="12" r="10" stroke={color} strokeWidth="2.25" fill="none" opacity="0.18" />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke={color}
        strokeWidth="2.25"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}
