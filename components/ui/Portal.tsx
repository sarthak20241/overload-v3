/**
 * Minimal portal system — renders content at the app root, in the SAME native
 * window as the rest of the UI (unlike React Native's <Modal>, which spawns a
 * separate Android Dialog window).
 *
 * Why this exists: on Android with edge-to-edge (forced in Expo SDK 54), a
 * <Modal>'s separate Dialog window is inset by the system navigation/gesture
 * bar, so a bottom-anchored sheet floats ABOVE the nav bar with an undimmed
 * gap below it (the tab bar shows through). That can't be fixed reliably from
 * JS — it's an upstream RN limitation. Rendering the sheet in the main window
 * instead (via this portal) makes it flush on both platforms and works in
 * Expo Go. See https://github.com/zoontek/react-native-edge-to-edge#modal-component-quirks
 *
 * Usage:
 *   <Portal>{visible && <YourOverlay />}</Portal>
 * The children render full-screen at the root, above the navigator (incl. tab
 * bar). Mount <PortalProvider> once near the app root, inside the context
 * providers your overlays depend on (Theme, Workout, SafeArea, …).
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
} from 'react';
import { View, StyleSheet } from 'react-native';

type PortalContextValue = {
  set: (key: string, node: React.ReactNode) => void;
  remove: (key: string) => void;
};

const PortalContext = createContext<PortalContextValue | null>(null);

export function PortalProvider({ children }: { children: React.ReactNode }) {
  const [nodes, setNodes] = useState<Record<string, React.ReactNode>>({});

  const set = useCallback((key: string, node: React.ReactNode) => {
    setNodes((prev) => ({ ...prev, [key]: node }));
  }, []);

  const remove = useCallback((key: string) => {
    setNodes((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  // Memoize so the context value is referentially stable. Without this, every
  // `setNodes` re-render produces a new value object → all <Portal> consumers
  // re-render → their effects call `set` again → infinite update loop.
  const value = useMemo(() => ({ set, remove }), [set, remove]);

  return (
    <PortalContext.Provider value={value}>
      {children}
      {/*
        Each portal gets its own absolute-fill host, rendered AFTER `children`
        so it paints on top of the navigator. `box-none` lets the host itself
        ignore touches while its children (e.g. a backdrop Pressable) handle
        them — so when nothing is mounted, touches pass straight through.
      */}
      {Object.entries(nodes).map(([key, node]) => (
        <View key={key} style={StyleSheet.absoluteFill} pointerEvents="box-none">
          {node}
        </View>
      ))}
    </PortalContext.Provider>
  );
}

export function Portal({ children }: { children: React.ReactNode }) {
  const ctx = useContext(PortalContext);
  const key = useId();

  // Keep the hosted node in sync with `children` on every render (children are
  // fresh elements each render, so no dep array).
  useEffect(() => {
    ctx?.set(key, children);
  });

  // Remove the entry only when this Portal unmounts for good.
  useEffect(() => {
    return () => ctx?.remove(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fallback when no provider is mounted: render inline so UI is never silently
  // dropped (also keeps <Portal> usable in isolation / tests).
  if (!ctx) return <>{children}</>;
  return null;
}
