import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        // Brand palette (saturated, logo)
        'brand-teal-deep': '#1F5862',
        'brand-teal': '#2D7E8C',
        'brand-red-deep': '#6E141C',
        'brand-red': '#A8232E',

        // UI palette — surfaces (dark mode default)
        'bg-base': '#0A0F1A',
        'bg-elevated': '#10172A',
        'bg-overlay': '#1A2238',
        'border-subtle': '#1F2A3F',
        'border-strong': '#2C3A55',

        // UI palette — text
        'text-primary': '#E6ECF5',
        'text-secondary': '#A8B3C7',
        'text-tertiary': '#6B788F',
        'text-disabled': '#465268',
        'text-inverse': '#0A0F1A',

        // UI palette — accents (luminous)
        'accent-teal': '#3DD9CC',
        'accent-coral': '#FF5C6E',
        'accent-amber': '#FFC93C',
        'accent-magenta': '#FF7AC6',
        'accent-success': '#5BD16D',

        // Code-block tokens
        'code-bg': '#0D1424',
      },
      fontFamily: {
        display: ['Manrope', 'Inter', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: [
          'Geist Mono',
          'JetBrains Mono',
          'ui-monospace',
          'SFMono-Regular',
          'monospace',
        ],
      },
      fontSize: {
        '7xl': ['4.5rem', { lineHeight: '1.05', letterSpacing: '-0.03em' }],
        '6xl': ['3.75rem', { lineHeight: '1.1', letterSpacing: '-0.025em' }],
        '5xl': ['3rem', { lineHeight: '1.15', letterSpacing: '-0.02em' }],
        '4xl': ['2.25rem', { lineHeight: '1.2', letterSpacing: '-0.015em' }],
        '3xl': ['1.875rem', { lineHeight: '1.25', letterSpacing: '-0.01em' }],
        '2xl': ['1.5rem', { lineHeight: '1.3', letterSpacing: '-0.005em' }],
        xl: ['1.25rem', { lineHeight: '1.4', letterSpacing: '0' }],
        lg: ['1.125rem', { lineHeight: '1.55', letterSpacing: '0' }],
        base: ['1rem', { lineHeight: '1.6', letterSpacing: '0' }],
        sm: ['0.875rem', { lineHeight: '1.5', letterSpacing: '0' }],
        xs: ['0.75rem', { lineHeight: '1.45', letterSpacing: '0.04em' }],
      },
      maxWidth: {
        prose: '65ch',
      },
      backgroundImage: {
        'brand-gradient':
          'linear-gradient(90deg, #3DD9CC 0%, #FFC93C 50%, #FF5C6E 100%)',
        'hero-glow':
          'radial-gradient(circle at 40% 50%, rgba(61,217,204,0.12), transparent 60%)',
        'subtle-glow':
          'radial-gradient(circle, rgba(61,217,204,0.15) 0%, transparent 60%)',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.55', transform: 'scale(0.92)' },
        },
        'ribbon-shimmer': {
          '0%, 100%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
        },
        'caret-blink': {
          '0%, 49%': { opacity: '1' },
          '50%, 100%': { opacity: '0' },
        },
      },
      animation: {
        'fade-up': 'fade-up 700ms cubic-bezier(0.22, 1, 0.36, 1) both',
        'pulse-soft': 'pulse-soft 2.4s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'ribbon-shimmer': 'ribbon-shimmer 9s ease-in-out infinite',
        'caret-blink': 'caret-blink 1.1s step-end infinite',
      },
    },
  },
  plugins: [],
} satisfies Config;
