/**
 * Which palette an orb loader draws in. The orb fades its far dots toward
 * its theme's background, so a tinted orb picks the side its ink contrasts
 * with: light ink fades to black, dark ink to white. No tint, a mid grey, or
 * a color this cannot read keeps the app theme.
 */
export function orbTheme(color: string | undefined, mode: 'dark' | 'light'): 'dark' | 'light' {
  const l = color ? luminance(color) : null;
  if (l == null) return mode;
  if (l > 0.6) return 'dark';
  if (l < 0.15) return 'light';
  return mode;
}

/** Brightness (0 to 1) of a #rgb, #rgba, #rrggbb, #rrggbbaa, rgb() or rgba()
 *  color; null for anything else. Alpha is ignored. This is Rec. 709 luma on
 *  the sRGB values as written, not linearized relative luminance: the 0.6 and
 *  0.15 cut-offs in orbTheme are tuned to it, so swapping in the linear
 *  formula would move every threshold. */
export function luminance(color: string): number | null {
  const c = color.trim();
  let rgb: number[] | null = null;
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(c);
  if (hex) {
    const h = hex[1].length <= 4 ? hex[1].split('').map((d) => d + d).join('') : hex[1];
    rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  } else {
    const fn = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/i.exec(c);
    if (fn) rgb = [fn[1], fn[2], fn[3]].map(Number);
  }
  if (!rgb || rgb.some((v) => v > 255)) return null;
  const [r, g, b] = rgb.map((v) => v / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
