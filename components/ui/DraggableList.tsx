import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayoutChangeEvent, StyleProp, ViewStyle } from 'react-native';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { haptics } from '@/lib/haptics';

// A generic long-press drag-to-reorder list. Renders plain Views (not a
// FlatList), so it can live INSIDE a ScrollView next to other content — which
// the routine editor needs (name/description fields above, "Add" button below).
//
// How it works: each row measures its own height (onLayout). From those heights
// we derive each row's natural top offset on the UI thread. While a row is
// dragged, the other rows shift up/down by one slot (height + gap) as the
// dragged row's centre crosses their centres; on release the dragged row
// settles into the target slot and we commit the new order to the parent.
//
// Variable row heights are supported (the routine editor's cards expand /
// collapse). Reordering is committed via onReorder(from, to) — the parent owns
// the data and re-renders in the new order.
//
// Limitation: there is no edge auto-scroll while dragging, and the parent
// freezes its own scroll during a drag (onDragStart/onDragEnd). So a row that
// is off-screen when the drag begins can't be reached in a single gesture —
// scroll it into view first, then drag. Fine for the short lists this is used
// for; revisit with an Animated.ScrollView + scrollTo if lists grow long.

export interface DragHandleProps {
  children: React.ReactNode;
  /** Disable activation (e.g. while saving). */
  disabled?: boolean;
}
/** Wrap the part of a row that should start the drag on long-press. */
export type DragHandle = React.ComponentType<DragHandleProps>;

export interface DraggableRenderInfo<T> {
  item: T;
  index: number;
  /** True while this row is the one being dragged. */
  isActive: boolean;
  /** Wrap your drag handle (e.g. a grip icon) in this to make it draggable. */
  Handle: DragHandle;
}

interface DraggableListProps<T> {
  data: T[];
  keyExtractor: (item: T, index: number) => string;
  renderItem: (info: DraggableRenderInfo<T>) => React.ReactNode;
  onReorder: (from: number, to: number) => void;
  /** Fires when a drag begins / ends — use to freeze a parent ScrollView. */
  onDragStart?: () => void;
  onDragEnd?: () => void;
  /** Vertical space between rows. Must match what you'd otherwise set as gap. */
  gap?: number;
  longPressMs?: number;
  style?: StyleProp<ViewStyle>;
}

// ── UI-thread helpers ───────────────────────────────────────────────────────
// Which slot the dragged row (originally at `active`) should land in, given its
// current finger translation. Thresholds use the static, pre-drag centres so
// the result is stable and predictable.
function computeInsertionIndex(
  active: number,
  dragTY: number,
  offsets: number[],
  heights: number[],
): number {
  'worklet';
  const n = offsets.length;
  if (active < 0 || active >= n) return active;
  const draggedCenter = offsets[active] + dragTY + (heights[active] ?? 0) / 2;
  let insertion = active;
  for (let j = 0; j < n; j++) {
    if (j === active) continue;
    const center = offsets[j] + (heights[j] ?? 0) / 2;
    if (j > active && draggedCenter >= center) insertion = Math.max(insertion, j);
    else if (j < active && draggedCenter <= center) insertion = Math.min(insertion, j);
  }
  return insertion;
}

// translateY that places the dragged row exactly over its destination slot, so
// the release animation lands flush where the committed reorder will redraw it
// (no jump). Derived in terms of the original offsets/heights (gaps cancel).
function targetTranslateY(
  active: number,
  to: number,
  offsets: number[],
  heights: number[],
): number {
  'worklet';
  if (to > active) return offsets[to] + (heights[to] ?? 0) - (heights[active] ?? 0) - offsets[active];
  if (to < active) return offsets[to] - offsets[active];
  return 0;
}

interface RowProps<T> {
  item: T;
  index: number;
  count: number;
  gap: number;
  longPressMs: number;
  renderItem: (info: DraggableRenderInfo<T>) => React.ReactNode;
  activeIndex: SharedValue<number>;
  dragTY: SharedValue<number>;
  isSettling: SharedValue<boolean>;
  settleTo: SharedValue<number>;
  offsets: Readonly<SharedValue<number[]>>;
  heights: SharedValue<number[]>;
  activeJsIndex: number;
  setHeight: (index: number, height: number) => void;
  onPick: (index: number) => void;
  onDrop: (from: number, to: number) => void;
}

function DraggableRow<T>({
  item, index, count, gap, longPressMs, renderItem,
  activeIndex, dragTY, isSettling, settleTo, offsets, heights,
  activeJsIndex, setHeight, onPick, onDrop,
}: RowProps<T>) {
  const onLayout = useCallback(
    (e: LayoutChangeEvent) => setHeight(index, e.nativeEvent.layout.height),
    [index, setHeight],
  );

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activateAfterLongPress(longPressMs)
        // Single finger only, and keep tracking once activated even if the
        // finger leaves the handle's bounds.
        .maxPointers(1)
        .shouldCancelWhenOutside(false)
        .onStart(() => {
          activeIndex.value = index;
          dragTY.value = 0;
          isSettling.value = false;
          settleTo.value = index;
          runOnJS(onPick)(index);
        })
        .onUpdate((e) => {
          dragTY.value = e.translationY;
        })
        .onEnd(() => {
          const to = computeInsertionIndex(index, dragTY.value, offsets.value, heights.value);
          isSettling.value = true;
          settleTo.value = to;
          const target = targetTranslateY(index, to, offsets.value, heights.value);
          // Commit regardless of `finished`: if the settle is interrupted (the
          // sheet closes mid-animation, the row remounts, another write to
          // dragTY) the callback fires with finished=false, and skipping onDrop
          // would leave activeIndex set and the parent ScrollView frozen.
          // onDrop is idempotent enough — it no-ops the reorder when from===to —
          // and onEnd/onFinalize for one gesture are mutually exclusive, so it
          // can't double-commit.
          dragTY.value = withTiming(target, { duration: 180 }, () => {
            runOnJS(onDrop)(index, to);
          });
        })
        // Guard: if the gesture is cancelled before it ever ended (so no settle
        // animation was scheduled), drop it in place so the list never gets
        // stuck holding an active row.
        .onFinalize((_e, success) => {
          if (!success) runOnJS(onDrop)(index, index);
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [index, count, longPressMs, onPick, onDrop],
  );

  const Handle = useMemo<DragHandle>(
    () =>
      ({ children, disabled }) =>
        disabled ? (
          <>{children}</>
        ) : (
          <GestureDetector gesture={pan}>
            {/* collapsable={false} is required on Android: a prop-less wrapper
                gets flattened out of the native tree, leaving the gesture
                handler nothing to attach to (so the press never registers). */}
            <Animated.View collapsable={false} style={{ alignSelf: 'center' }}>
              {children}
            </Animated.View>
          </GestureDetector>
        ),
    [pan],
  );

  const animatedStyle = useAnimatedStyle(() => {
    const active = activeIndex.value;
    if (active === -1) {
      return { transform: [{ translateY: 0 }, { scale: 1 }], zIndex: 0, opacity: 1, elevation: 0, shadowOpacity: 0 };
    }
    if (index === active) {
      return {
        transform: [{ translateY: dragTY.value }, { scale: 1.03 }],
        zIndex: 999,
        opacity: 0.97,
        shadowColor: '#000',
        shadowOpacity: 0.18,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 6 },
        elevation: 10,
      };
    }
    const insertion = isSettling.value
      ? settleTo.value
      : computeInsertionIndex(active, dragTY.value, offsets.value, heights.value);
    const slot = (heights.value[active] ?? 0) + gap;
    let shift = 0;
    if (active < insertion && index > active && index <= insertion) shift = -slot;
    else if (active > insertion && index >= insertion && index < active) shift = slot;
    return {
      transform: [{ translateY: withTiming(shift, { duration: 160 }) }, { scale: 1 }],
      zIndex: 0,
      opacity: 1,
      elevation: 0,
      shadowOpacity: 0,
    };
  });

  return (
    <Animated.View
      onLayout={onLayout}
      style={[{ marginBottom: index === count - 1 ? 0 : gap }, animatedStyle]}
    >
      {renderItem({ item, index, isActive: index === activeJsIndex, Handle })}
    </Animated.View>
  );
}

export function DraggableList<T>({
  data,
  keyExtractor,
  renderItem,
  onReorder,
  onDragStart,
  onDragEnd,
  gap = 0,
  longPressMs = 220,
  style,
}: DraggableListProps<T>) {
  const activeIndex = useSharedValue(-1);
  const dragTY = useSharedValue(0);
  const isSettling = useSharedValue(false);
  const settleTo = useSharedValue(-1);
  const heights = useSharedValue<number[]>([]);
  const [activeJsIndex, setActiveJsIndex] = useState(-1);

  const offsets = useDerivedValue(() => {
    const hs = heights.value;
    const out: number[] = [];
    let acc = 0;
    for (let i = 0; i < hs.length; i++) {
      out.push(acc);
      acc += (hs[i] ?? 0) + gap;
    }
    return out;
  }, [gap]);

  const dataLenRef = useRef(data.length);
  dataLenRef.current = data.length;

  const setHeight = useCallback((index: number, h: number) => {
    const cur = heights.value;
    if (cur[index] === h && cur.length === dataLenRef.current) return;
    const next = cur.slice();
    next[index] = h;
    next.length = dataLenRef.current; // drop any stale tail after a removal
    heights.value = next;
  }, [heights]);

  const onPick = useCallback((index: number) => {
    setActiveJsIndex(index);
    haptics.medium();
    onDragStart?.();
  }, [onDragStart]);

  const onDrop = useCallback((from: number, to: number) => {
    if (from !== to) {
      onReorder(from, to);
      haptics.success();
    }
    activeIndex.value = -1;
    dragTY.value = 0;
    isSettling.value = false;
    settleTo.value = -1;
    setActiveJsIndex(-1);
    onDragEnd?.();
  }, [onReorder, onDragEnd, activeIndex, dragTY, isSettling, settleTo]);

  return (
    <Animated.View style={style}>
      {data.map((item, index) => (
        <DraggableRow
          key={keyExtractor(item, index)}
          item={item}
          index={index}
          count={data.length}
          gap={gap}
          longPressMs={longPressMs}
          renderItem={renderItem}
          activeIndex={activeIndex}
          dragTY={dragTY}
          isSettling={isSettling}
          settleTo={settleTo}
          offsets={offsets}
          heights={heights}
          activeJsIndex={activeJsIndex}
          setHeight={setHeight}
          onPick={onPick}
          onDrop={onDrop}
        />
      ))}
    </Animated.View>
  );
}
