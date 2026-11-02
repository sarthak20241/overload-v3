/**
 * A TextInput for content rendered through <Portal>. Use it wherever the text
 * lives in state owned OUTSIDE the portal (the component that renders
 * <Portal>, or above it). Drop-in: same props as TextInput.
 *
 * Why: <Portal> hands its children to <PortalHost> from an effect, so the
 * input gets the owner's new text late. Meanwhile the TextInput re-renders
 * itself on every keystroke to bump its native event count. That render pairs
 * the NEWEST event count with the OLD text, and Android takes the pair as an
 * order to put the old text back: letters vanish or come back scrambled when
 * you type fast. `defaultValue` does not avoid this — on Android RN sends
 * defaultValue down as the native text on every render, so a defaultValue fed
 * from state is still controlled.
 *
 * This component keeps the text in its own state. It renders inside the portal,
 * so the text and the event count always move together. Which owner values it
 * shows (resets, seeds, filtered values) and which it ignores (late echoes of
 * what was typed) is decided in lib/sheetText.ts, with tests.
 *
 * Proven on the Android emulator, 2026-11-01, typing fast with adb: the custom
 * exercise name field lost or scrambled letters in 4 of 4 runs as a plain
 * TextInput with defaultValue, and in 0 of 5 runs as this component.
 */
import React, { forwardRef, useLayoutEffect, useRef, useState } from 'react';
import { TextInput, type TextInputProps } from 'react-native';
import {
  sheetTextCommitted,
  sheetTextInit,
  sheetTextOwnerRendered,
  sheetTextTyped,
} from '@/lib/sheetText';

export const SheetTextInput = forwardRef<TextInput, TextInputProps>(function SheetTextInput(
  { value, defaultValue, onChangeText, ...rest },
  ref,
) {
  const external = value ?? defaultValue ?? '';
  const model = useRef(sheetTextInit(external));
  const [text, setText] = useState(external);

  // No deps: it counts every commit, and checks the owner's value every time,
  // even when it did not change (a filter that put the text back to what it
  // was). A render for this box's own keystroke still holds the owner's older
  // value; the model ignores that one because the keystroke is in this commit.
  useLayoutEffect(() => {
    const next = sheetTextOwnerRendered(model.current, external);
    if (next.text !== model.current.text) setText(next.text);
    model.current = sheetTextCommitted(next);
  });

  return (
    <TextInput
      ref={ref}
      {...rest}
      value={text}
      onChangeText={(t) => {
        model.current = sheetTextTyped(model.current, t);
        setText(t);
        onChangeText?.(t);
      }}
    />
  );
});
