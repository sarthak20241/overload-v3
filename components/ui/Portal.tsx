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
 *
 * Implementation note (the important bit): the registered nodes live in an
 * external store (a ref + listener set), NOT in PortalProvider's own state.
 * That's deliberate. A <Portal>'s sync effect runs on every render (children
 * are fresh elements each render) and writes to the store. If that write
 * re-rendered PortalProvider, React would re-render the whole navigator
 * subtree below it — including the <Portal> — whose effect would write again →
 * infinite "maximum update depth" loop. By keeping the registry in a store and
 * subscribing ONLY the host (<PortalHost>) to it, a write re-renders just the
 * host; the provider and the app tree never re-render, so consumers can't be
 * re-triggered. No loop, regardless of how many portals exist or how often
 * their owners re-render.
 */
import React, {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useSyncExternalStore,
} from 'react';
import { View, StyleSheet } from 'react-native';

type Nodes = Record<string, React.ReactNode>;

type PortalStore = {
  set: (key: string, node: React.ReactNode) => void;
  remove: (key: string) => void;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => Nodes;
};

const PortalContext = createContext<PortalStore | null>(null);

function createPortalStore(): PortalStore {
  // `nodes` is only ever reassigned (never mutated) so getSnapshot returns a
  // stable reference between writes — required by useSyncExternalStore.
  let nodes: Nodes = {};
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());

  return {
    set(key, node) {
      nodes = { ...nodes, [key]: node };
      emit();
    },
    remove(key) {
      if (!(key in nodes)) return;
      const next = { ...nodes };
      delete next[key];
      nodes = next;
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return nodes;
    },
  };
}

export function PortalProvider({ children }: { children: React.ReactNode }) {
  // The store lives for the lifetime of the provider. PortalProvider itself
  // holds NO state, so node changes never re-render it (or `children`).
  const storeRef = useRef<PortalStore | null>(null);
  if (storeRef.current === null) storeRef.current = createPortalStore();

  return (
    <PortalContext.Provider value={storeRef.current}>
      {children}
      {/* Host renders AFTER children so portalled content paints on top of the
          navigator. It subscribes to the store, so only it re-renders when
          nodes change. */}
      <PortalHost store={storeRef.current} />
    </PortalContext.Provider>
  );
}

function PortalHost({ store }: { store: PortalStore }) {
  const nodes = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return (
    <>
      {/*
        Each portal gets its own absolute-fill host. `box-none` lets the host
        itself ignore touches while its children (e.g. a backdrop Pressable)
        handle them — so when nothing is mounted, touches pass straight through.
      */}
      {Object.entries(nodes).map(([key, node]) => (
        <View key={key} style={StyleSheet.absoluteFill} pointerEvents="box-none">
          {node}
        </View>
      ))}
    </>
  );
}

export function Portal({ children }: { children: React.ReactNode }) {
  const store = useContext(PortalContext);
  const key = useId();

  // Keep the hosted node in sync with `children` on every render (children are
  // fresh elements each render, so no dep array). This writes to the store,
  // which re-renders ONLY <PortalHost> — never this component — so it can't
  // loop. See the file header for why that separation matters.
  useEffect(() => {
    store?.set(key, children);
  });

  // Remove the entry only when this Portal unmounts for good.
  useEffect(() => {
    return () => store?.remove(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fallback when no provider is mounted: render inline so UI is never silently
  // dropped (also keeps <Portal> usable in isolation / tests).
  if (!store) return <>{children}</>;
  return null;
}
