/**
 * A TextInput for content rendered through <Portal>. Use it wherever the text
 * lives in state owned OUTSIDE the portal (the component that renders
 * <Portal>, or above it). Drop-in: same props as TextInput.
 *
 * Why: <Portal> hands its children to <PortalHost> from an effect, so the
 * input gets the owner's new text one step late. Meanwhile the TextInput
 * re-renders itself on every keystroke to bump its native event count. That
 * render pairs the NEWEST event count with the OLD text, and Android takes the
 * pair as an order to put the old text back: letters vanish or come back
 * scrambled when you type fast. `defaultValue` does not avoid this — on Android
 * RN sends defaultValue down as the native text on every render, so a
 * defaultValue fed from state is still controlled.
 *
 * This component keeps the text in its own state. It renders inside the portal,
 * so the text and the event count always move together. A new `value` (or
 * `defaultValue`) from the owner is taken only when it is not just the owner
 * catching up with what was typed: a reset, a seed, or a filtered value.
 *
 * Proven on the Android emulator, 2026-11-01, typing fast with adb: the custom
 * exercise name field lost or scrambled letters in 4 of 4 runs as a plain
 * TextInput with defaultValue, and in 0 of 5 runs as this component.
 */
import React, { forwardRef, useLayoutEffect, useRef, useState } from 'react';
import { TextInput, type TextInputProps } from 'react-native';

// Enough to cover a fast typist's lead over a slow owner render.
const MAX_PENDING = 64;

export const SheetTextInput = forwardRef<TextInput, TextInputProps>(function SheetTextInput(
  { value, defaultValue, onChangeText, ...rest },
  ref,
) {
  const external = value ?? defaultValue ?? '';
  const [text, setText] = useState(external);
  // Text sent up through onChangeText that the owner has not echoed back yet.
  const pending = useRef<string[]>([]);

  useLayoutEffect(() => {
    const i = pending.current.indexOf(external);
    if (i >= 0) {
      // The owner caught up with something typed here. Drop it and anything
      // older; the local text is already ahead.
      pending.current = pending.current.slice(i + 1);
      return;
    }
    pending.current = [];
    setText(external);
  }, [external]);

  return (
    <TextInput
      ref={ref}
      {...rest}
      value={text}
      onChangeText={(t) => {
        setText(t);
        pending.current.push(t);
        if (pending.current.length > MAX_PENDING) pending.current.shift();
        onChangeText?.(t);
      }}
    />
  );
});
