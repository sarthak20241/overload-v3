import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Keyboard, Platform, ScrollView, TextInput,
  type NativeScrollEvent, type NativeSyntheticEvent,
} from 'react-native';

// Gap left between the focused field's bottom edge and the keyboard's top.
// Android leaves Gboard's toolbar/suggestion strip OUT of the reported keyboard
// height, so a small gap lands the field half-behind that strip. ~60px clears a
// typical strip and still reads as "just above the keyboard".
const ABOVE_KEYBOARD = 60;

/**
 * Keeps the focused TextInput visible above the software keyboard inside a
 * plain ScrollView.
 *
 * Why this exists: Expo SDK 54 forces always-on edge-to-edge on Android, which
 * stops the Activity from resizing for the IME. The window no longer shrinks,
 * so inputs in the lower half of a scroll stay buried under the keyboard — RN's
 * built-in "scroll focused field into view" only works when the window resizes.
 * We make room ourselves (pad the content by the keyboard height) and scroll
 * the focused field above the keyboard. iOS is unaffected — there the
 * ScrollView's own `automaticallyAdjustKeyboardInsets` (or a KeyboardAvoidingView)
 * handles it, so the helpers below no-op on iOS.
 *
 * The scroll is deferred until the bottom padding has actually been laid out
 * (via the ScrollView's onContentSizeChange): scrolling before that gets
 * clamped to the old, shorter content height, so the field only lifts part of
 * the way. A timeout is the fallback for when the padding was already present
 * (e.g. the keyboard re-opens at the same height and content size doesn't move).
 *
 * Usage:
 *   const { kbHeight, scrollRef, scrollFocusedIntoView, scrollProps } = useKeyboardAwareScroll();
 *   <ScrollView ref={scrollRef} {...scrollProps}
 *     contentContainerStyle={[base, Platform.OS === 'android' && kbHeight > 0 && { paddingBottom: kbHeight + 120 }]}
 *     automaticallyAdjustKeyboardInsets /* iOS *​/ >
 *   // and pass onFocus={scrollFocusedIntoView} to each TextInput so switching
 *   // fields while the keyboard stays open also re-lifts the new field.
 *
 * @param enabled Pass false while another overlay (a Portal sheet with its own
 *   keyboard handling) is open, so this hook doesn't fight it by scrolling the
 *   now-hidden background scroll.
 */
export function useKeyboardAwareScroll(enabled: boolean = true) {
  const scrollRef = useRef<ScrollView>(null);
  const scrollYRef = useRef(0);
  // Top edge (window Y) of the keyboard while it's up; 0 when it's down.
  const kbTopRef = useRef(0);
  // Set when a keyboard-show is waiting for the padding to lay out before we
  // scroll; consumed by onContentSizeChange or the timeout fallback.
  const pendingScrollRef = useRef(false);
  const [kbHeight, setKbHeight] = useState(0);

  // Lift the currently focused input clear of the keyboard. Android-only and a
  // no-op until the keyboard is up (kbTopRef known); iOS handles itself.
  const performScroll = useCallback(() => {
    if (Platform.OS !== 'android') return;
    const kbTop = kbTopRef.current;
    if (kbTop <= 0) return;
    const scroll = scrollRef.current;
    const focused = TextInput.State.currentlyFocusedInput?.();
    if (!scroll || !focused?.measureInWindow) return;
    focused.measureInWindow((_x, y, _w, h) => {
      // How far the field's bottom edge sits below the target line (keyboard top
      // minus the toolbar gap). Positive => scroll up by exactly that much, so
      // the field lands just above the keyboard. Negative => already clear.
      const overlap = y + h + ABOVE_KEYBOARD - kbTop;
      if (overlap > 0) scroll.scrollTo({ y: scrollYRef.current + overlap, animated: true });
    });
  }, []);

  // For an input's onFocus: if the keyboard is already up, the padding is
  // already there, so scroll now. Otherwise the show-listener handles it.
  const scrollFocusedIntoView = useCallback(() => {
    if (kbTopRef.current > 0) performScroll();
  }, [performScroll]);

  useEffect(() => {
    if (!enabled) {
      kbTopRef.current = 0;
      pendingScrollRef.current = false;
      setKbHeight(0);
      return;
    }
    // iOS gets the *Will* events (smoother, fires before the frame); Android
    // only reports a reliable height on *Did*.
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, (e) => {
      kbTopRef.current = e.endCoordinates?.screenY ?? 0;
      // Add the bottom room first; scroll once it's laid out (see below).
      pendingScrollRef.current = true;
      setKbHeight(e.endCoordinates?.height ?? 0);
      // Fallback: if the content size doesn't change (padding already present),
      // onContentSizeChange won't fire, so scroll after a beat instead.
      setTimeout(() => {
        if (pendingScrollRef.current) { pendingScrollRef.current = false; performScroll(); }
      }, 150);
    });
    const hideSub = Keyboard.addListener(hideEvt, () => {
      kbTopRef.current = 0;
      pendingScrollRef.current = false;
      setKbHeight(0);
    });
    return () => { showSub.remove(); hideSub.remove(); };
  }, [enabled, performScroll]);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollYRef.current = e.nativeEvent.contentOffset.y;
  }, []);

  // Runs after the keyboard padding grows the content — now the scroll range is
  // tall enough to lift the field all the way above the keyboard.
  const onContentSizeChange = useCallback(() => {
    if (pendingScrollRef.current) { pendingScrollRef.current = false; performScroll(); }
  }, [performScroll]);

  return {
    kbHeight,
    scrollRef,
    scrollFocusedIntoView,
    scrollProps: { onScroll, scrollEventThrottle: 16, onContentSizeChange },
  };
}
