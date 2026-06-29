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
    // Status colors as TEXT. On dark the bright base colors already pass WCAG AA,
    // so these equal the base; the light theme overrides them with darker values.
    successText: '#10b981',
    warningText: '#f59e0b',
    dangerText: '#ef4444',
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
    // Theme-aware macro hues — spread across the wheel (terracotta / teal / gold) so
    // the three read distinct by HUE + VALUE + CVD, not the old near-isoluminant
    // earthy trio. Over-target = oxblood, pulled out of the amber band so "over"
    // never twins protein. Calories = foreground (the ring). Letters P/C/F reinforce.
    macro: { protein: '#e0876b', carbs: '#52b9ae', fat: '#d4a73c' },
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
    borderLight: 'rgba(0,0,0,0.12)',
    inputBg: '#f0efe9',
    elevated: '#ffffff',
    navBg: 'rgba(255,255,255,0.92)',
    textMuted: '#6b7280',
    textDim: '#9ca3af',
    textSecondary: '#645d58',
    accentText: '#4d7a00',
    // Darker status-text variants that pass WCAG AA on cream/white (the bright
    // base colors fail: success 2.54, warning 2.15, danger 3.76 on white).
    successText: '#047857',
    warningText: '#b45309',
    dangerText: '#c2371f',
    primaryMuted: 'rgba(77,122,0,0.08)',
    primarySubtle: 'rgba(77,122,0,0.10)',
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
    legendBorder: 'rgba(0,0,0,0.12)',
    statusBar: 'dark' as const,
    // Theme-aware macro hues — terracotta / teal / gold, distinct by HUE + VALUE +
    // CVD and all ≥3:1 on cream/white. Over-target = oxblood (dark crimson), distinct
    // from terracotta by value so "over" never twins protein. Letters P/C/F reinforce.
    macro: { protein: '#bf4d34', carbs: '#2c8a80', fat: '#9e7b1f' },
  },

  // Routine / stat accent colors
  routineColors: ['#84cc16', '#06b6d4', '#a855f7', '#f59e0b', '#10b981', '#f97316'],

  // Stat colors (used in dashboard widgets). The canonical data-viz palette:
  // reference these everywhere a metric needs a colour, so e.g. Volume is the
  // SAME colour on the dashboard and on analytics (it previously diverged).
  stat: {
    workouts: '#84cc16',
    streak: '#f97316',
    volume: '#06b6d4',
    muscles: '#a855f7',
    duration: '#a855f7',
    sets: '#10b981',
  },

  // Muscle-group accents (dashboard donut + tags). Categorical, theme-independent.
  // Toned: distinct hues (colour still encodes which muscle) but desaturated to a
  // cohesive, harmonised set instead of clashing full-saturation primaries.
  muscle: {
    Chest: '#e09a9a',
    Back: '#9bb8e3',
    Shoulders: '#eccf94',
    Quads: '#97cbb4',
    Hamstrings: '#98c9d4',
    Biceps: '#c3aee0',
    Triceps: '#e6a8c8',
    Calves: '#c4dd9a',
    Core: '#f0b58f',
    Glutes: '#9fd0c4',
    'Full Body': '#b6a8e0',
  } as Record<string, string>,

  // Profile data-field row-icon accents. Categorical.
  rowIcon: {
    gender: '#a855f7',
    height: '#06b6d4',
    weight: '#10b981',
    goal: '#f59e0b',
    bodyFat: '#ef4444',
    bug: '#f97316',
    trainingGoal: '#84cc16',
    experience: '#3b82f6',
    frequency: '#8b5cf6',
    trainingAge: '#ec4899',
    dob: '#14b8a6',
  },

  // History calendar intensity (lime-green heatmap; alpha by session count).
  calendar: {
    base: '#84cc16', // a trained day (opacity scales with intensity)
    multi: '#a3e635', // 2 sessions
    max: '#facc15', // 3+ sessions
  },

  // Macro accents (diet day-view rings, food rows). Categorical, theme-independent,
  // in the muted register of `muscle`. Calories graphite reads as the neutral primary;
  // protein/carbs/fat are earthy and co-equal — lime is reserved for the one action,
  // never for data (see feedback: calm/mature, not flashy).
  macro: {
    calories: '#2c2c26',
    protein: '#b4623c',
    carbs: '#6f7b85',
    fat: '#be9a4a',
  } as Record<string, string>,

  // Paused / warning amber (mini-bar paused badge, workout pause state).
  paused: '#fbbf24',

  // Semantic
  danger: '#ef4444',
  dangerBg: 'rgba(239,68,68,0.10)',
  success: '#10b981',
  warning: '#f59e0b',
};

// Convert a hex colour + alpha (0–1) to an rgba() string. Use instead of
// hand-writing rgba() literals or `${hex}33`-style suffixes, so tinted fills
// stay derived from a single source colour.
export function colorWithAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Icon size scale — mirrors FontSize so the app's deliberately compact icon
// convention (11–16px inline, 20–24px standalone) is enforced, not guessed.
export const IconSize = {
  xs: 11,
  sm: 14,
  md: 16,
  lg: 20,
  xl: 24,
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
  hero: 44, // the single biggest number on a screen (e.g. a day's calorie total)
};

export const FontWeight = {
  regular: '400' as const,
  medium: '500' as const,
  semibold: '600' as const,
  bold: '700' as const,
  black: '900' as const,
};

// Letter-spacing scale. The app tracks titles/big numbers tight and all-caps
// labels wide; naming the values keeps them consistent instead of hand-tuned
// per screen. Use with numbers that also carry tabular figures.
export const LetterSpacing = {
  tight: -0.5, // screen titles, hero/big numbers
  snug: -0.2, // subtitles, large body
  normal: 0,
  label: 0.6, // stat-card labels
  eyebrow: 1.5, // section labels (all-caps)
  caps: 2, // greeting / wide all-caps
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
