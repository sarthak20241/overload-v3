/**
 * The exercise pill row at the top of the live workout.
 *
 * Tap a pill to open that exercise. Hold a pill to unlock reorder mode: every
 * pill starts a small shake (like the home screen icons of a phone), and the
 * held pill lifts and follows the finger. While the mode is on, a round tick
 * button (Done) sits pinned at the right edge, so the way out shows however long the row is.
 * The mode also ends on a touch outside the row (the screen asks touchedInside),
 * by itself after a few idle seconds, or on Android back.
 *
 * The drag is react-native-reorderable-list in horizontal mode (the same
 * library as the routine editor): it owns the lift, the shuffle and the edge
 * auto-scroll. This file only adds the shake and the mode.
 */
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { BackHandler, Pressable, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions, type FlatList } from 'react-native';
import Animated, {
  cancelAnimation, Easing, FadeIn, runOnJS, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue,
  withRepeat, withSequence, withTiming,
} from 'react-native-reanimated';
import ReorderableList, {
  useIsActive, useReorderableDrag, type ReorderableListReorderEvent,
} from 'react-native-reorderable-list';
import { Feather } from '@expo/vector-icons';
import { Colors, FontWeight, Radius, Spacing, colorWithAlpha } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { LinearGradient } from 'expo-linear-gradient';
import { haptics } from '@/lib/haptics';
import { pillKeys } from '@/lib/exerciseOrder';
import type { ActiveWorkoutExercise } from '@/lib/types';

const GAP = 8;
const PAD = Spacing.xl;
/** Reorder mode ends by itself after this long with no touch on the row. */
const IDLE_EXIT_MS = 5000;
const HOLD_TO_UNLOCK_MS = 320;
const HOLD_TO_DRAG_MS = 130;
const SHAKE_DEG = 1.8;
/** Room kept at the end of the row so the last pill can scroll clear of the pinned Done. */
const DONE_SPACE = 44;
const DONE_FADE = 24;

export interface ExercisePillStripHandle {
  /** Scroll the row the minimum needed to show pill `idx` with some margin. */
  reveal: (idx: number) => void;
  /**
   * True when the touch that just began is on the row. It reads once and
   * clears. The screen calls it from its own onTouchStart (which runs after
   * the row's), to end reorder mode on a touch anywhere else.
   */
  touchedInside: () => boolean;
}

interface Props {
  exercises: ActiveWorkoutExercise[];
  currentIdx: number;
  finished: boolean[];
  reorderMode: boolean;
  onReorderModeChange: (on: boolean) => void;
  onSelect: (idx: number) => void;
  onMove: (from: number, to: number) => void;
  onAdd: () => void;
}

interface PillItem {
  key: string;
  name: string;
  grouped: boolean;
}

function Pill({
  item, index, isCurrent, isDone, reorderMode, onPress, onHold, onWidth,
}: {
  item: PillItem;
  index: number;
  isCurrent: boolean;
  isDone: boolean;
  reorderMode: boolean;
  onPress: (idx: number) => void;
  onHold: () => void;
  onWidth: (key: string, width: number) => void;
}) {
  const { C } = useTheme();
  const drag = useReorderableDrag();
  const isActive = useIsActive();
  const rot = useSharedValue(0);
  // The pill in the hand does not shake: it is "picked up".
  const shake = reorderMode && !isActive;

  useEffect(() => {
    cancelAnimation(rot);
    if (!shake) {
      rot.value = withTiming(0, { duration: 120 });
      return;
    }
    // Neighbours start in opposite directions at slightly different speeds, so
    // the row looks alive and not like one block that tilts.
    const dir = index % 2 === 0 ? 1 : -1;
    const dur = 110 + (index % 3) * 14;
    rot.value = withSequence(
      withTiming(dir * SHAKE_DEG, { duration: dur / 2, easing: Easing.out(Easing.quad) }),
      withRepeat(withTiming(-dir * SHAKE_DEG, { duration: dur, easing: Easing.inOut(Easing.quad) }), -1, true),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shake, index]);

  const shakeStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${rot.value}deg` }] }));
  const label = item.name.length > 16 ? item.name.slice(0, 14) + '…' : item.name;

  return (
    <Animated.View style={[styles.cell, shakeStyle]}>
      <Pressable
        onPress={() => onPress(index)}
        onLongPress={() => { onHold(); drag(); }}
        delayLongPress={reorderMode ? HOLD_TO_DRAG_MS : HOLD_TO_UNLOCK_MS}
        hitSlop={{ top: 8, bottom: 8, left: 0, right: 0 }}
        onLayout={(e) => onWidth(item.key, e.nativeEvent.layout.width)}
        accessibilityRole="button"
        accessibilityLabel={item.name}
        accessibilityHint="Hold, then drag, to change the exercise order"
        style={[
          styles.pill,
          {
            backgroundColor: isCurrent ? Colors.primary : isDone ? C.primarySubtle : C.muted,
            // Superset members share a lime outline so the group reads as a
            // bracket at the nav level too (restrained: alpha'd, not filled).
            borderColor: isCurrent
              ? Colors.primary
              : item.grouped
                ? colorWithAlpha(Colors.primary, 0.55)
                : isDone
                  ? C.primaryBorder
                  : C.border,
          },
        ]}
      >
        {isDone && <Feather name="check" size={10} color={C.accentText} style={{ marginRight: 4 }} />}
        <Text
          style={[styles.pillText, { color: isCurrent ? Colors.primaryFg : isDone ? C.accentText : C.textMuted }]}
          numberOfLines={1}
        >
          {label}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

export const ExercisePillStrip = forwardRef<ExercisePillStripHandle, Props>(function ExercisePillStrip(
  { exercises, currentIdx, finished, reorderMode, onReorderModeChange, onSelect, onMove, onAdd },
  ref,
) {
  const { C } = useTheme();
  const { width: winW } = useWindowDimensions();
  const listRef = useRef<FlatList<PillItem>>(null);

  const items = useMemo<PillItem[]>(() => {
    const keys = pillKeys(exercises);
    return exercises.map((ex, i) => ({ key: keys[i], name: ex.exercise.name, grouped: ex.supersetGroup != null }));
  }, [exercises]);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // ---- Reveal the open pill ------------------------------------------------
  // Pill widths vary with the name, so each pill reports its width (kept by key,
  // so it follows the pill through a reorder) and the frame is summed from them.
  const widthsRef = useRef(new Map<string, number>());
  const scrollXSV = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler({ onScroll: (e) => { scrollXSV.value = e.contentOffset.x; } });
  // frameOf reads refs only. reveal and onWidth close over it with no dep, so
  // keep it that way: no props or state in here.
  const frameOf = (idx: number): { x: number; width: number } | null => {
    const list = itemsRef.current;
    if (idx < 0 || idx >= list.length) return null;
    let x = PAD;
    for (let j = 0; j < idx; j++) {
      const w = widthsRef.current.get(list[j].key);
      if (w == null) return null;
      x += w + GAP;
    }
    const width = widthsRef.current.get(list[idx].key);
    return width == null ? null : { x, width };
  };
  // A reveal asked for before its pill is measured (the first paint, or a pill
  // just added) waits here; onWidth runs it when the widths arrive.
  const pendingRevealRef = useRef<number | null>(currentIdx);
  const reveal = useCallback((idx: number) => {
    const frame = frameOf(idx);
    if (!frame) { pendingRevealRef.current = idx; return; }
    pendingRevealRef.current = null;
    const margin = 48; // breathing room so a sliver of the neighbour stays visible
    const off = scrollXSV.value;
    const left = frame.x;
    const right = frame.x + frame.width;
    // Already comfortably on-screen: leave the row where the user left it.
    if (left >= off + margin && right <= off + winW - margin) return;
    const target = left < off + margin ? left - margin : right - winW + margin;
    listRef.current?.scrollToOffset({ offset: Math.max(0, target), animated: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [winW]);
  const touchedInsideRef = useRef(false);
  const markTouchInside = useCallback(() => { touchedInsideRef.current = true; }, []);
  useImperativeHandle(ref, () => ({
    reveal,
    touchedInside: () => {
      const inside = touchedInsideRef.current;
      touchedInsideRef.current = false;
      return inside;
    },
  }), [reveal]);

  // The first full measure shows the open (or resumed) exercise; a later one
  // shows a pill that was added after it.
  const onWidth = useCallback((key: string, width: number) => {
    widthsRef.current.set(key, width);
    const pending = pendingRevealRef.current;
    if (pending == null) return;
    if (pending >= itemsRef.current.length) { pendingRevealRef.current = null; return; }
    if (frameOf(pending)) reveal(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);

  // ---- Reorder mode --------------------------------------------------------
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopIdle = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = null;
  }, []);
  const startIdle = useCallback(() => {
    stopIdle();
    idleTimer.current = setTimeout(() => onReorderModeChange(false), IDLE_EXIT_MS);
  }, [stopIdle, onReorderModeChange]);
  // True while a pill is in the air, so the idle timer never ends a live drag.
  const draggingRef = useRef(false);
  useEffect(() => {
    touchedInsideRef.current = false;
    if (!reorderMode) { stopIdle(); return; }
    // The hold that unlocks the mode normally starts a drag, and the drag end
    // starts the timer. If that drag never engages, this start is the only one.
    if (!draggingRef.current) startIdle();
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onReorderModeChange(false); return true; });
    return () => { sub.remove(); stopIdle(); };
  }, [reorderMode, onReorderModeChange, stopIdle, startIdle]);

  const onHold = useCallback(() => {
    if (!reorderMode) {
      haptics.tap();
      onReorderModeChange(true);
    } else {
      haptics.tick();
    }
  }, [reorderMode, onReorderModeChange]);
  const onPress = useCallback((idx: number) => {
    if (reorderMode) startIdle();
    onSelect(idx);
  }, [reorderMode, startIdle, onSelect]);

  // The library calls these on the UI thread.
  const dragBegan = useCallback(() => { draggingRef.current = true; stopIdle(); }, [stopIdle]);
  const dragEnded = useCallback(() => { draggingRef.current = false; startIdle(); }, [startIdle]);
  const onDragStart = useCallback(() => { 'worklet'; runOnJS(dragBegan)(); }, [dragBegan]);
  const onDragEnd = useCallback(() => { 'worklet'; runOnJS(dragEnded)(); }, [dragEnded]);
  const onReorder = useCallback(({ from, to }: ReorderableListReorderEvent) => {
    if (from === to) return;
    haptics.tick();
    onMove(from, to);
  }, [onMove]);

  const renderItem = useCallback(({ item, index }: { item: PillItem; index: number }) => (
    <Pill
      item={item}
      index={index}
      isCurrent={index === currentIdx}
      isDone={!!finished[index]}
      reorderMode={reorderMode}
      onPress={onPress}
      onHold={onHold}
      onWidth={onWidth}
    />
  ), [currentIdx, finished, reorderMode, onPress, onHold, onWidth]);

  // In reorder mode the "+" gives its place to empty room: Done is pinned over
  // the right edge (below), and the last pill must be able to scroll clear of it.
  const footer = reorderMode ? (
    <View style={{ width: DONE_SPACE }} />
  ) : (
    <View>
      <TouchableOpacity
        onPress={onAdd}
        style={[styles.addPill, { borderColor: C.border }]}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Add exercise"
      >
        <Feather name="plus" size={13} color={C.textMuted} />
      </TouchableOpacity>
    </View>
  );

  return (
    // The handler and collapsable={false} never change with the mode. A wrapper
    // that turns from layout-only into a real view while a finger is down gets
    // its children moved natively, and that ends the drag that just began.
    <View collapsable={false} onTouchStart={markTouchInside}>
      <ReorderableList
        ref={listRef}
        data={items}
        keyExtractor={(it) => it.key}
        renderItem={renderItem}
        extraData={renderItem}
        horizontal
        shouldUpdateActiveItem
        showsHorizontalScrollIndicator={false}
        // Every pill stays mounted: the row is short, and reveal() needs each width.
        initialNumToRender={Math.max(10, items.length)}
        windowSize={41}
        onReorder={onReorder}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onScroll={onScroll}
        onScrollBeginDrag={reorderMode ? startIdle : undefined}
        style={styles.list}
        contentContainerStyle={styles.content}
        ListFooterComponent={footer}
        ListFooterComponentStyle={styles.footer}
      />
      {reorderMode && (
        <Animated.View entering={FadeIn.duration(140)} style={styles.doneDock} pointerEvents="box-none">
          <LinearGradient
            pointerEvents="none"
            colors={[colorWithAlpha(C.background, 0), C.background]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.doneFade}
          />
          <View style={[styles.doneBack, { backgroundColor: C.background }]}>
            <TouchableOpacity
              onPress={() => { haptics.selection(); onReorderModeChange(false); }}
              style={[styles.donePill, { backgroundColor: Colors.primary }]}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Done with the exercise order"
            >
              <Feather name="check" size={14} color={Colors.primaryFg} />
            </TouchableOpacity>
          </View>
        </Animated.View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  list: { flexGrow: 0 },
  content: { paddingHorizontal: PAD, paddingVertical: Spacing.sm, alignItems: 'center' },
  // The gap rides inside the cell (not a container `gap`) so the library, which
  // measures cells, shuffles by the full pill + gap distance.
  cell: { paddingRight: GAP },
  footer: { justifyContent: 'center' },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: Radius.full,
    borderWidth: 1,
  },
  pillText: { fontSize: 11, fontWeight: FontWeight.semibold },
  addPill: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderStyle: 'dashed',
  },
  doneDock: { position: 'absolute', top: 0, bottom: 0, right: 0, flexDirection: 'row' },
  doneFade: { width: DONE_FADE },
  doneBack: { justifyContent: 'center', paddingLeft: 4, paddingRight: PAD },
  // A round tick, the size of the "+" it stands in for: a button, not one more pill.
  donePill: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
