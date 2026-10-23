/**
 * Thin outline icons for the Goal screen, drawn to match the approved
 * reference (.planning/phase-metrics/shots/goal-screen-v2-reference.webp):
 * a dumbbell with plates, an upright fork and knife, a crescent moon, and the
 * focus sparkle, all on one 24-unit grid with the same stroke. Inline
 * react-native-svg, which has shipped since the first build, so no new
 * dependency and nothing native.
 *
 * The fork and knife, moon and sparkle paths are Lucide's (lucide-static
 * 0.460.0: utensils, moon, sparkle); the dumbbell is drawn here in the same
 * stroke. Lucide is ISC licensed:
 *
 *   ISC License
 *   Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as
 *   part of Feather (MIT). All other copyright (c) for Lucide are held by
 *   Lucide Contributors 2022.
 *   Permission to use, copy, modify, and/or distribute this software for any
 *   purpose with or without fee is hereby granted, provided that the above
 *   copyright notice and this permission notice appear in all copies.
 *   THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 *   WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 *   MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 *   ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 *   WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 *   ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 *   OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */
import type { ReactNode } from 'react';
import Svg, { Path, Rect } from 'react-native-svg';

export interface LineIconProps {
  size?: number;
  color: string;
  strokeWidth?: number;
}

function Icon({ size = 26, color, strokeWidth = 1.75, children }: LineIconProps & { children: ReactNode }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </Svg>
  );
}

/**
 * A level dumbbell, as in the reference: a bar, a tall plate and a short plate
 * on each side. Drawn here in the same stroke (Lucide's dumbbell is on the
 * diagonal, and turned level its plates read as two blobs at 26pt).
 */
export function DumbbellIcon(p: LineIconProps) {
  return (
    <Icon {...p}>
      <Path d="M8.5 12h7" />
      <Rect x="5.5" y="6.5" width="3" height="11" rx="1.2" />
      <Rect x="15.5" y="6.5" width="3" height="11" rx="1.2" />
      <Path d="M3 9.5v5" />
      <Path d="M21 9.5v5" />
    </Icon>
  );
}

/** An upright fork and knife, side by side. */
export function UtensilsIcon(p: LineIconProps) {
  return (
    <Icon {...p}>
      <Path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2" />
      <Path d="M7 2v20" />
      <Path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7" />
    </Icon>
  );
}

/** A crescent moon. */
export function MoonIcon(p: LineIconProps) {
  return (
    <Icon {...p}>
      <Path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </Icon>
  );
}

/** The focus sparkle. */
export function SparkleIcon(p: LineIconProps) {
  return (
    <Icon {...p}>
      <Path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
    </Icon>
  );
}
