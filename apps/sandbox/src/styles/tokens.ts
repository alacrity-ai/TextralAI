// "The Quarterly" — editorial dark palette, lifted from V2 frontend.
//
// Warm ink instead of cold gray. A single restrained accent in antique
// gold-leaf. Semantic colors are pulled toward earth tones (olive,
// terracotta) so they sit inside the editorial register rather than
// shouting Tailwind defaults.

export const colors = {
  // Surfaces — warm near-black on raised paper-feel cards.
  bgBase: '#13110f',
  bgCard: '#1a1714',
  bgElevated: '#221d18',
  bgInput: '#181513',
  bgSubtle: '#161310',

  // Accent — antique gold leaf.
  primary: '#c9a961',
  primaryHover: '#d9bb74',
  primaryActive: '#a88b48',
  primaryMuted: 'rgba(201, 169, 97, 0.16)',
  accent: '#e0c896',

  // Text — warm ivory on warm ink.
  textPrimary: '#f1e9dd',
  textSecondary: '#a8a098',
  textMuted: '#74695f',

  // Semantic — earth tones.
  success: '#8a9a5b',
  warning: '#c9a961',
  danger: '#a64038',
  info: '#c9a961',

  // Borders — hairlines.
  border: '#2a2520',
  borderEmphasis: '#3a342d',
  hairline: 'rgba(201, 169, 97, 0.18)',

  // Citation — soft gold halo.
  citationHighlight: 'rgba(201, 169, 97, 0.20)',
  citationActive: 'rgba(224, 200, 150, 0.45)',
  citationBorder: '#c9a961',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

export const radii = {
  sm: 3,
  md: 6,
  lg: 10,
  full: 9999,
};

export const fonts = {
  display: "'Fraunces', 'Cormorant Garamond', Georgia, serif",
  sans: "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  serif: "'Fraunces', 'Cormorant Garamond', Georgia, serif",
  mono: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
};

export const typography = {
  display: {
    fontFamily: fonts.display,
    fontWeight: 400,
    fontVariationSettings: '"opsz" 144, "SOFT" 30',
    letterSpacing: '-0.02em',
  } as React.CSSProperties,
  displayItalic: {
    fontFamily: fonts.display,
    fontStyle: 'italic',
    fontWeight: 400,
    fontVariationSettings: '"opsz" 144, "SOFT" 60',
  } as React.CSSProperties,
  body: {
    fontFamily: fonts.sans,
    fontWeight: 400,
    letterSpacing: '-0.005em',
  } as React.CSSProperties,
  smallCaps: {
    fontFamily: fonts.sans,
    fontWeight: 500,
    fontSize: 11,
    letterSpacing: '0.18em',
    textTransform: 'uppercase',
  } as React.CSSProperties,
  mono: {
    fontFamily: fonts.mono,
    fontVariantLigatures: 'none',
  } as React.CSSProperties,
};

export const shadows = {
  card: '0 1px 0 rgba(0,0,0,0.4), 0 8px 24px -12px rgba(0,0,0,0.5)',
  elevated: '0 8px 32px -8px rgba(0,0,0,0.6), 0 2px 0 rgba(255,255,255,0.02) inset',
};
