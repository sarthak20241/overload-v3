// Exact colors from Figma Make design system
export const Colors = {
  // Primary accent - lime green (same in both themes)
  primary: '#c8ff00',
  primaryFg: '#0a0a0a',

  // Sign in with Apple — brand-locked per Apple HIG, theme-independent.
  // The "Sign in with Apple" button must be solid black or solid white;
  // no other variants are HIG-compliant. Kept at the top level (not in
  // light/dark palettes) because the values do not change with theme.
  appleBg: '#000000',
  appleFg: '#ffffff',

  // Dark theme
  dark: {
    background: '#0a0a0a',
    foreground: '#ffffff',
    card: '#1c1c1e',
    cardFg: '#ffffff',
    muted: '#242428',
    mutedFg: '#a1a1aa',
    border: 'rgba(255,255,255,0.14)',
    borderSubtle: 'rgba(255,255,255,0.10)',
    borderLight: 'rgba(255,255,255,0.12)',
    inputBg: '#242428',
    elevated: '#1c1c1e',
    navBg: 'rgba(10,10,10,0.95)',
    textMuted: '#8a8a93',
    textDim: '#6a6a72',
    textSecondary: '#a1a1aa',
    accentText: '#c8ff00',
    primaryMuted: 'rgba(200,255,0,0.10)',
    primarySubtle: 'rgba(200,255,0,0.05)',
    primaryBorder: 'rgba(200,255,0,0.20)',
    circleBg: '#c8ff00',
    circleFg: '#0a0a0a',
    surfaceHover: '#222222',
    // Theme-aware UI tokens
    handle: 'rgba(255,255,255,0.20)',
    overlay: 'rgba(0,0,0,0.70)',
    closeBtn: 'rgba(255,255,255,0.06)',
    glowBg: 'rgba(255,255,255,0.03)',
    legendDivider: 'rgba(255,255,255,0.10)',
    legendBorder: 'rgba(255,255,255,0.06)',
    statusBar: 'light' as const,
  },

  // Light theme
  light: {
    background: '#f7f6f1',
    foreground: '#1a1a1a',
    card: '#ffffff',
    cardFg: '#1a1a1a',
    muted: '#efeee8',
    mutedFg: '#6b6b6b',
    border: 'rgba(0,0,0,0.08)',
    borderSubtle: 'rgba(0,0,0,0.05)',
    borderLight: 'rgba(0,0,0,0.06)',
    inputBg: '#f0efe9',
    elevated: '#ffffff',
    navBg: 'rgba(255,255,255,0.92)',
    textMuted: '#6b7280',
    textDim: '#9ca3af',
    textSecondary: '#78716c',
    accentText: '#4d7a00',
    primaryMuted: 'rgba(77,122,0,0.08)',
    primarySubtle: 'rgba(77,122,0,0.04)',
    primaryBorder: 'rgba(77,122,0,0.20)',
    circleBg: '#ffffff',
    circleFg: '#4d7a00',
    surfaceHover: '#f5f4ef',
    // Theme-aware UI tokens
    handle: 'rgba(0,0,0,0.15)',
    overlay: 'rgba(0,0,0,0.40)',
    closeBtn: 'rgba(0,0,0,0.06)',
    glowBg: 'rgba(0,0,0,0.03)',
    legendDivider: 'rgba(0,0,0,0.10)',
    legendBorder: 'rgba(0,0,0,0.06)',
    statusBar: 'dark' as const,
  },

  // Routine / stat accent colors
  routineColors: ['#84cc16', '#06b6d4', '#a855f7', '#f59e0b', '#10b981', '#f97316'],

  // Stat colors (used in dashboard widgets)
  stat: {
    workouts: '#84cc16',
    streak: '#f97316',
    volume: '#06b6d4',
    muscles: '#a855f7',
    duration: '#a855f7',
    sets: '#10b981',
  },

  // Semantic
  danger: '#ef4444',
  dangerBg: 'rgba(239,68,68,0.10)',
  success: '#10b981',
  warning: '#f59e0b',
};

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
};

export const Radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  full: 999,
};

export const FontSize = {
  xs: 10,
  sm: 12,
  md: 13,
  base: 14,
  lg: 16,
  xl: 18,
  xxl: 22,
  xxxl: 28,
  display: 36,
};

export const FontWeight = {
  regular: '400' as const,
  medium: '500' as const,
  semibold: '600' as const,
  bold: '700' as const,
  black: '900' as const,
};

// Shadow presets
export const Shadow = {
  card: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 2,
  },
  elevated: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 6,
  },
  playBtn: {
    shadowColor: '#c8ff00',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.30,
    shadowRadius: 16,
    elevation: 8,
  },
};
