import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator,
  RefreshControl, BackHandler, Pressable, TextInput, useWindowDimensions,
  Platform, Keyboard,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import Animated, {
  FadeInDown, SlideInDown, SlideOutDown, Easing,
  useSharedValue, useAnimatedStyle, withTiming, withDelay,
} from 'react-native-reanimated';
import { Colors, Spacing, Radius, FontSize, FontWeight, Shadow } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { Portal } from '@/components/ui/Portal';
import { useBasicInfo } from '@/hooks/useBasicInfo';
import { useSupabaseClient } from '@/lib/supabase';
import { roundVolume } from '@/lib/format';
import { getGuestWorkoutsDetailed } from '@/lib/guestStore';
import { MiniAreaChart } from '@/components/ui/MiniAreaChart';
import { useClerkUser } from '@/hooks/useClerkUser';
import { useIsGuestSession } from '@/lib/guestMode';
import { hydrateCache, readCache, writeCache } from '@/lib/localCache';
import { getPendingWorkouts } from '@/lib/syncQueue';
import { pendingToDashboardWorkout } from '@/lib/pendingAdapters';
import { useSync } from '@/components/SyncProvider';
import {
  loadWeightLog, saveWeightLog, loadBodyFatLog, saveBodyFatLog,
  loadMeasurements, saveMeasurements,
  type WeightEntry, type BodyFatEntry, type MeasurementEntry, type MeasurementsData,
} from '@/lib/bodyStats';

const ROUTINE_COLORS = Colors.routineColors;

interface WorkoutRaw {
  id: string;
  name: string;
  started_at: string;
  duration_seconds?: number;
  total_volume_kg?: number;
  workout_sets?: WorkoutSetRaw[];
}

interface WorkoutSetRaw {
  id: string;
  weight_kg: number;
  reps: number;
  exercise_id: string;
  exercises?: { id: string; name: string; muscle_group: string };
}

function formatDateShort(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDateLong(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Progress bar ─────────────────────────────────────────────────────────────
function AnimatedBar({ progress, color, bg, delay = 0 }: { progress: number; color: string; bg: string; delay?: number }) {
  const width = useSharedValue(0);
  useEffect(() => {
    width.value = withDelay(delay, withTiming(Math.min(progress, 1), { duration: 700 }));
  }, [progress, delay]);
  const animStyle = useAnimatedStyle(() => ({ width: `${width.value * 100}%` as any }));
  return (
    <View style={[styles.barTrack, { backgroundColor: bg }]}>
      <Animated.View style={[styles.barFill, { backgroundColor: color }, animStyle]} />
    </View>
  );
}

// ─── Mini area card (Volume / Duration) ───────────────────────────────────────
function MiniAreaCard({
  icon, label, value, suffix, color, data, labels, valueSuffix,
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  label: string;
  value: string;
  suffix: string;
  color: string;
  data: number[];
  labels: string[];
  valueSuffix?: string;
}) {
  const { C } = useTheme();
  const hasData = data.some((v) => v > 0);
  return (
    <View style={[styles.miniCard, { backgroundColor: C.card, borderColor: C.borderSubtle }, Shadow.card]}>
      <View style={[styles.cardGlow, { backgroundColor: color, opacity: 0.04 }]} />
      <View style={styles.miniHeader}>
        <Feather name={icon} size={12} color={color} />
        <Text style={[styles.miniLabel, { color }]}>{label.toUpperCase()}</Text>
      </View>
      <View style={styles.miniValueRow}>
        <Text style={[styles.miniValue, { color: C.foreground }]}>{value}</Text>
        <Text style={[styles.miniSuffix, { color: C.textMuted }]}> {suffix}</Text>
      </View>
      {hasData ? (
        <View style={{ marginTop: 4, marginHorizontal: -2 }}>
          <MiniAreaChart
            data={data}
            labels={labels}
            width={140}
            height={68}
            color={color}
            valueSuffix={valueSuffix}
            tooltipBgColor={C.elevated}
            tooltipTextColor={C.foreground}
          />
        </View>
      ) : (
        <View style={styles.noDataMini}>
          <Text style={[styles.noDataText, { color: C.textDim }]}>No data</Text>
        </View>
      )}
    </View>
  );
}

// ─── Stat mini card (Sets / Reps) ─────────────────────────────────────────────
function StatMiniCard({
  icon, label, value, suffix, color, progress, target,
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  label: string;
  value: number;
  suffix: string;
  color: string;
  progress: number;
  target: string;
}) {
  const { C } = useTheme();
  return (
    <View style={[styles.miniCard, { backgroundColor: C.card, borderColor: C.borderSubtle }, Shadow.card]}>
      <View style={[styles.cardGlow, { backgroundColor: color, opacity: 0.04 }]} />
      <View style={styles.miniHeader}>
        <Feather name={icon} size={12} color={color} />
        <Text style={[styles.miniLabel, { color }]}>{label.toUpperCase()}</Text>
      </View>
      <View style={styles.miniValueRow}>
        <Text style={[styles.miniValue, { color: C.foreground }]}>{value}</Text>
        <Text style={[styles.miniSuffix, { color: C.textMuted }]}> {suffix}</Text>
      </View>
      <View style={{ marginTop: 6 }}>
        <AnimatedBar progress={progress} color={color} bg={`${color}26`} />
      </View>
      <Text style={[styles.targetText, { color: C.textDim }]}>{target}</Text>
    </View>
  );
}

// ─── Exercise Dropdown ────────────────────────────────────────────────────────
function ExerciseDropdown({
  exercises, selected, onSelect,
}: { exercises: string[]; selected: string; onSelect: (n: string) => void }) {
  const { C } = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.dropdownWrap}>
      <TouchableOpacity
        onPress={() => setOpen((v) => !v)}
        style={[styles.dropdownBtn, { backgroundColor: C.muted, borderColor: C.border }]}
      >
        <Text style={[styles.dropdownText, { color: C.foreground }]} numberOfLines={1}>
          {selected || 'Select exercise...'}
        </Text>
        <Feather name={open ? 'chevron-up' : 'chevron-down'} size={14} color={C.textMuted} />
      </TouchableOpacity>
      {open && (
        <View style={[styles.dropdownList, { backgroundColor: C.elevated, borderColor: C.border }, Shadow.elevated]}>
          {exercises.length === 0 ? (
            <Text style={[styles.dropdownEmpty, { color: C.textMuted }]}>No exercises found</Text>
          ) : (
            <ScrollView style={{ maxHeight: 200 }}>
              {exercises.map((ex) => (
                <TouchableOpacity
                  key={ex}
                  onPress={() => { onSelect(ex); setOpen(false); }}
                  style={[styles.dropdownItem, { borderBottomColor: C.border }, ex === selected && { backgroundColor: C.primarySubtle }]}
                >
                  <Text style={[styles.dropdownItemText, { color: ex === selected ? C.accentText : C.foreground, fontWeight: ex === selected ? FontWeight.semibold : FontWeight.regular }]}>
                    {ex}
                  </Text>
                  {ex === selected && <Feather name="check" size={14} color={C.accentText} />}
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
        </View>
      )}
    </View>
  );
}

// ─── Segmented Toggle ─────────────────────────────────────────────────────────
function SegmentedToggle({
  options, selected, onSelect,
}: { options: { key: string; label: string }[]; selected: string; onSelect: (v: string) => void }) {
  const { C } = useTheme();
  return (
    <View style={[styles.segWrap, { backgroundColor: C.muted }]}>
      {options.map((opt) => (
        <TouchableOpacity
          key={opt.key}
          onPress={() => onSelect(opt.key)}
          style={[styles.segPill, selected === opt.key && { backgroundColor: Colors.primary }]}
        >
          <Text style={[
            styles.segText,
            { color: selected === opt.key ? Colors.primaryFg : C.textSecondary },
          ]}>
            {opt.label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ─── Bottom drawer (reusable) ─────────────────────────────────────────────────
function BottomDrawer({
  visible, onClose, children,
}: { visible: boolean; onClose: () => void; children: React.ReactNode }) {
  const { C } = useTheme();
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [kbHeight, setKbHeight] = useState(0);

  // <Portal> has no onRequestClose, so wire the Android hardware back button.
  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, onClose]);

  // Track keyboard height on both platforms. On iOS the Modal does not resize,
  // so we lift the sheet via marginBottom. On Android the Activity's adjustResize
  // shifts the Save button above the keyboard, but useWindowDimensions().height
  // does NOT shrink inside a Modal — so without subtracting kbHeight from
  // maxHeight, the drawer renders at its full (unshrunk) maxHeight and its top
  // overflows above the visible window.
  useEffect(() => {
    if (!visible) { setKbHeight(0); return; }
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, (e) => {
      setKbHeight(e.endCoordinates?.height ?? 0);
    });
    const hideSub = Keyboard.addListener(hideEvt, () => setKbHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [visible]);

  const sheetMaxHeight = (height - kbHeight) * 0.9;
  // Lift above the keyboard on both platforms — rendered in the app's own
  // window via <Portal>, which isn't auto-resized for the keyboard.
  const sheetMarginBottom = kbHeight;

  return (
    <Portal>
      {visible && (
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable style={[StyleSheet.absoluteFillObject, { backgroundColor: C.overlay }]} onPress={onClose} />
        {(
          <Animated.View
            entering={SlideInDown.duration(320).easing(Easing.out(Easing.cubic))}
            exiting={SlideOutDown.duration(200)}
            style={[
              styles.drawerSheet,
              {
                marginBottom: sheetMarginBottom,
                maxHeight: sheetMaxHeight,
                backgroundColor: C.elevated,
                borderColor: C.border,
                // Flush to the screen bottom now (Portal), so clear the gesture bar.
                paddingBottom: insets.bottom,
              },
            ]}
          >
            {/* Plain View — a Pressable here would steal pan gestures from any
                ScrollView in {children}, breaking scroll inside the drawer. */}
            <View style={{ flexShrink: 1 }}>
              <View style={[styles.drawerHandle, { backgroundColor: C.handle }]} />
              {children}
            </View>
          </Animated.View>
        )}
      </View>
      )}
    </Portal>
  );
}

// ─── Add Entry Modal ──────────────────────────────────────────────────────────
function AddEntryModal({
  visible, onClose, title, label, unit, initial, color, icon, onSave,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  label: string;
  unit: string;
  initial: string;
  color: string;
  icon: React.ComponentProps<typeof Feather>['name'];
  onSave: (value: number) => void;
}) {
  const { C } = useTheme();
  const [value, setValue] = useState(initial);
  useEffect(() => { if (visible) setValue(initial); }, [visible, initial]);

  const submit = () => {
    const num = parseFloat(value);
    if (isNaN(num) || num <= 0) return;
    onSave(num);
    onClose();
  };

  return (
    <BottomDrawer visible={visible} onClose={onClose}>
      <View style={styles.addHeader}>
        <View style={[styles.addIcon, { backgroundColor: `${color}26` }]}>
          <Feather name={icon} size={16} color={color} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.addTitle, { color: C.foreground }]}>{title}</Text>
          <Text style={[styles.addSub, { color: C.textMuted }]}>{formatDateLong(new Date().toISOString())}</Text>
        </View>
        <TouchableOpacity onPress={onClose} style={[styles.closeBtn, { backgroundColor: C.closeBtn }]}>
          <Feather name="x" size={15} color={C.foreground} />
        </TouchableOpacity>
      </View>
      <View style={{ paddingHorizontal: Spacing.xl, paddingBottom: Spacing.xl }}>
        <Text style={[styles.fieldLabel, { color: C.textMuted }]}>{label} ({unit})</Text>
        <TextInput
          value={value}
          onChangeText={setValue}
          keyboardType="decimal-pad"
          placeholder={`0 ${unit}`}
          placeholderTextColor={C.textDim}
          autoFocus={Platform.OS === 'ios'}
          style={[styles.textInput, { backgroundColor: C.muted, borderColor: C.border, color: C.foreground }]}
        />
        <TouchableOpacity
          onPress={submit}
          style={[styles.saveBtn, { backgroundColor: Colors.primary }]}
          activeOpacity={0.8}
        >
          <Feather name="check" size={14} color={Colors.primaryFg} />
          <Text style={[styles.saveBtnText, { color: Colors.primaryFg }]}>Save Entry</Text>
        </TouchableOpacity>
      </View>
    </BottomDrawer>
  );
}

// ─── History Drawer ───────────────────────────────────────────────────────────
function HistoryDrawer({
  visible, onClose, title, entries, unit, color, icon, onDelete,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  entries: { date: string; value: number }[];
  unit: string;
  color: string;
  icon: React.ComponentProps<typeof Feather>['name'];
  onDelete: (date: string) => void;
}) {
  const { C } = useTheme();
  const reversed = [...entries].reverse();
  return (
    <BottomDrawer visible={visible} onClose={onClose}>
      <View style={styles.addHeader}>
        <View style={[styles.addIcon, { backgroundColor: `${color}26` }]}>
          <Feather name={icon} size={16} color={color} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.addTitle, { color: C.foreground }]}>{title}</Text>
          <Text style={[styles.addSub, { color: C.textMuted }]}>{entries.length} entries logged</Text>
        </View>
        <TouchableOpacity onPress={onClose} style={[styles.closeBtn, { backgroundColor: C.closeBtn }]}>
          <Feather name="x" size={15} color={C.foreground} />
        </TouchableOpacity>
      </View>
      <ScrollView
        style={{ maxHeight: 400 }}
        contentContainerStyle={{ paddingHorizontal: Spacing.xl, paddingBottom: 32, gap: 8 }}
        showsVerticalScrollIndicator={false}
      >
        {reversed.map((entry, i) => {
          const prev = i < reversed.length - 1 ? reversed[i + 1] : null;
          const diff = prev ? entry.value - prev.value : 0;
          return (
            <View key={entry.date} style={[styles.historyRow, { backgroundColor: C.muted, borderColor: C.borderSubtle }]}>
              <Text style={[styles.historyDate, { color: C.textSecondary }]}>
                {formatDateLong(entry.date)}
              </Text>
              <View style={styles.historyRight}>
                {diff !== 0 && (
                  <View style={[styles.diffBadge, { backgroundColor: diff > 0 ? 'rgba(239,68,68,0.15)' : 'rgba(16,185,129,0.15)' }]}>
                    <Text style={[styles.diffText, { color: diff > 0 ? '#ef4444' : '#10b981' }]}>
                      {diff > 0 ? '+' : ''}{diff.toFixed(1)}
                    </Text>
                  </View>
                )}
                <Text style={[styles.historyValue, { color: C.foreground }]}>
                  {entry.value}<Text style={[styles.historyUnit, { color: C.textMuted }]}> {unit}</Text>
                </Text>
                <TouchableOpacity onPress={() => onDelete(entry.date)} style={[styles.deleteBtn, { backgroundColor: C.closeBtn }]}>
                  <Feather name="minus" size={10} color={C.textMuted} />
                </TouchableOpacity>
              </View>
            </View>
          );
        })}
      </ScrollView>
    </BottomDrawer>
  );
}

// ─── Trend Card (Weight / Body Fat) ───────────────────────────────────────────
function TrendCard({
  title, icon, color, unit, log, goal, chartWidth, onAdd, onDelete, onRefreshLog,
}: {
  title: string;
  icon: React.ComponentProps<typeof Feather>['name'];
  color: string;
  unit: string;
  log: { date: string; value: number }[];
  goal?: number | null;
  chartWidth: number;
  onAdd: () => void;
  onDelete: (date: string) => void;
  onRefreshLog: () => void;
}) {
  const { C } = useTheme();
  const [historyOpen, setHistoryOpen] = useState(false);
  const sorted = useMemo(() => [...log].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()), [log]);
  const latest = sorted[sorted.length - 1];
  const first = sorted[0];
  const diff = sorted.length >= 2 ? latest.value - first.value : 0;
  const hasChart = sorted.length >= 2;
  const data = sorted.map((e) => e.value);
  const labels = sorted.map((e) => formatDateShort(e.date));

  return (
    <>
      <View style={[styles.bigCard, { backgroundColor: C.card, borderColor: C.borderSubtle }, Shadow.card]}>
        <View style={[styles.cardGlow, { backgroundColor: color, opacity: 0.04 }]} />
        <View style={styles.trendHeader}>
          <View style={styles.trendHeaderLeft}>
            <Feather name={icon} size={14} color={color} />
            <Text style={[styles.trendTitle, { color: C.foreground }]}>{title}</Text>
          </View>
          <View style={styles.trendHeaderRight}>
            {sorted.length === 0 ? null : (
              <>
                {diff !== 0 && (
                  <Text style={[styles.diffText, { color: diff > 0 ? '#ef4444' : '#10b981', fontWeight: FontWeight.bold }]}>
                    {diff > 0 ? '+' : ''}{diff.toFixed(1)} {unit}
                  </Text>
                )}
                <Text style={[styles.trendLatest, { color: C.foreground }]}>
                  {latest.value}<Text style={[styles.trendUnit, { color: C.textMuted }]}> {unit}</Text>
                </Text>
              </>
            )}
            <TouchableOpacity onPress={onAdd} style={[styles.plusBtn, { backgroundColor: `${color}26` }]}>
              <Feather name="plus" size={14} color={color} />
            </TouchableOpacity>
          </View>
        </View>

        {sorted.length === 0 ? (
          <View style={styles.emptyTrend}>
            <Text style={[styles.emptyText, { color: C.textMuted }]}>No {title.toLowerCase()} entries yet</Text>
            <Text style={[styles.emptyHint, { color: C.textDim }]}>Tap + to log your first entry</Text>
          </View>
        ) : hasChart ? (
          <View style={{ marginTop: 8 }}>
            <MiniAreaChart
              data={data}
              labels={labels}
              width={chartWidth}
              height={120}
              color={color}
              valueSuffix={unit}
              tooltipBgColor={C.elevated}
              tooltipTextColor={C.foreground}
            />
            {goal != null && (
              <Text style={[styles.goalLabel, { color: '#f59e0b' }]}>Goal: {goal} {unit}</Text>
            )}
          </View>
        ) : (
          <View style={styles.emptyTrend}>
            <Text style={[styles.singleValue, { color: C.accentText }]}>{latest.value} {unit}</Text>
            <Text style={[styles.emptyHint, { color: C.textDim }]}>Log more to see a trend</Text>
          </View>
        )}

        {sorted.length > 0 && (
          <TouchableOpacity
            onPress={() => setHistoryOpen(true)}
            style={[styles.showHistoryBtn, { borderTopColor: C.borderSubtle }]}
          >
            <Feather name="calendar" size={10} color={C.accentText} />
            <Text style={[styles.showHistoryText, { color: C.accentText }]}>
              Show history ({sorted.length})
            </Text>
          </TouchableOpacity>
        )}
      </View>

      <HistoryDrawer
        visible={historyOpen}
        onClose={() => setHistoryOpen(false)}
        title={`${title} History`}
        entries={sorted}
        unit={unit}
        color={color}
        icon={icon}
        onDelete={(date) => { onDelete(date); onRefreshLog(); }}
      />
    </>
  );
}

// ─── Body Measurements Card ───────────────────────────────────────────────────
type MeasurementKey = keyof Omit<MeasurementEntry, 'id' | 'date'>;

interface MeasurementField {
  key: MeasurementKey;
  label: string;
  shortLabel: string;
  color: string;
  group: 'Upper Body' | 'Arms' | 'Core' | 'Legs';
}

const MEASUREMENT_FIELDS: MeasurementField[] = [
  { key: 'chest', label: 'Chest', shortLabel: 'Chest', color: '#ef4444', group: 'Upper Body' },
  { key: 'shoulders', label: 'Shoulders', shortLabel: 'Shoulders', color: '#f97316', group: 'Upper Body' },
  { key: 'neck', label: 'Neck', shortLabel: 'Neck', color: '#64748b', group: 'Upper Body' },
  { key: 'bicepL', label: 'Bicep (L)', shortLabel: 'Bicep L', color: '#06b6d4', group: 'Arms' },
  { key: 'bicepR', label: 'Bicep (R)', shortLabel: 'Bicep R', color: '#0ea5e9', group: 'Arms' },
  { key: 'forearmL', label: 'Forearm (L)', shortLabel: 'Forearm L', color: '#8b5cf6', group: 'Arms' },
  { key: 'forearmR', label: 'Forearm (R)', shortLabel: 'Forearm R', color: '#a855f7', group: 'Arms' },
  { key: 'waist', label: 'Waist', shortLabel: 'Waist', color: '#f59e0b', group: 'Core' },
  { key: 'hips', label: 'Hips', shortLabel: 'Hips', color: '#eab308', group: 'Core' },
  { key: 'thighL', label: 'Thigh (L)', shortLabel: 'Thigh L', color: '#10b981', group: 'Legs' },
  { key: 'thighR', label: 'Thigh (R)', shortLabel: 'Thigh R', color: '#34d399', group: 'Legs' },
  { key: 'calfL', label: 'Calf (L)', shortLabel: 'Calf L', color: '#84cc16', group: 'Legs' },
  { key: 'calfR', label: 'Calf (R)', shortLabel: 'Calf R', color: '#a3e635', group: 'Legs' },
];

const MEASUREMENT_GROUPS: MeasurementField['group'][] = ['Upper Body', 'Arms', 'Core', 'Legs'];

function makeId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function MeasurementHistoryDrawer({
  visible, onClose, data, onDelete,
}: {
  visible: boolean;
  onClose: () => void;
  data: MeasurementsData;
  onDelete: (id: string) => void;
}) {
  const { C } = useTheme();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  useEffect(() => { if (!visible) setConfirmId(null); }, [visible]);

  return (
    <BottomDrawer visible={visible} onClose={onClose}>
      <View style={styles.addHeader}>
        <View style={[styles.addIcon, { backgroundColor: 'rgba(245,158,11,0.15)' }]}>
          <Feather name="calendar" size={16} color="#f59e0b" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.addTitle, { color: C.foreground }]}>Measurement History</Text>
          <Text style={[styles.addSub, { color: C.textMuted }]}>{data.entries.length} entries logged</Text>
        </View>
        <TouchableOpacity onPress={onClose} style={[styles.closeBtn, { backgroundColor: C.closeBtn }]}>
          <Feather name="x" size={15} color={C.foreground} />
        </TouchableOpacity>
      </View>
      <ScrollView
        style={{ flexGrow: 0, flexShrink: 1, maxHeight: 480 }}
        contentContainerStyle={{ paddingHorizontal: Spacing.xl, paddingBottom: 32, gap: 10 }}
        showsVerticalScrollIndicator={true}
        nestedScrollEnabled
      >
        {data.entries.map((entry) => {
          const filled = MEASUREMENT_FIELDS.filter((f) => entry[f.key] !== undefined);
          return (
            <View key={entry.id} style={[styles.mEntryCard, { backgroundColor: C.muted, borderColor: C.borderSubtle }]}>
              <View style={styles.mEntryHead}>
                <Text style={[styles.mEntryDate, { color: C.foreground }]}>
                  {formatDateLong(entry.date)}
                </Text>
                {confirmId === entry.id ? (
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    <TouchableOpacity
                      onPress={() => setConfirmId(null)}
                      style={[styles.mConfirmBtn, { backgroundColor: C.closeBtn }]}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      accessibilityRole="button"
                      accessibilityLabel="Cancel delete"
                    >
                      <Feather name="x" size={12} color={C.foreground} />
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => { onDelete(entry.id); setConfirmId(null); }}
                      style={[styles.mConfirmBtn, { backgroundColor: 'rgba(239,68,68,0.20)' }]}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      accessibilityRole="button"
                      accessibilityLabel="Confirm delete measurement"
                    >
                      <Feather name="trash-2" size={12} color="#ef4444" />
                    </TouchableOpacity>
                  </View>
                ) : (
                  <TouchableOpacity
                    onPress={() => setConfirmId(entry.id)}
                    style={[styles.mConfirmBtn, { backgroundColor: 'transparent' }]}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    accessibilityRole="button"
                    accessibilityLabel="Delete measurement"
                  >
                    <Feather name="trash-2" size={12} color={C.textDim} />
                  </TouchableOpacity>
                )}
              </View>
              <View style={styles.mEntryGrid}>
                {filled.map((f) => (
                  <View key={f.key} style={styles.mEntryCell}>
                    <View style={[styles.mDot, { backgroundColor: f.color }]} />
                    <Text style={[styles.mCellLabel, { color: C.textMuted }]} numberOfLines={1}>{f.shortLabel}</Text>
                    <Text style={[styles.mCellValue, { color: C.foreground }]}>
                      {entry[f.key]}
                      <Text style={[styles.mCellUnit, { color: C.textDim }]}> {data.unit}</Text>
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          );
        })}
      </ScrollView>
    </BottomDrawer>
  );
}

function LogMeasurementsDrawer({
  visible, onClose, unit, lastEntry, onSave,
}: {
  visible: boolean;
  onClose: () => void;
  unit: 'cm' | 'in';
  lastEntry?: MeasurementEntry;
  onSave: (entry: MeasurementEntry) => void;
}) {
  const { C } = useTheme();
  const { height: winH } = useWindowDimensions();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (visible) {
      const prefill: Record<string, string> = {};
      if (lastEntry) {
        MEASUREMENT_FIELDS.forEach((f) => {
          const v = lastEntry[f.key];
          if (v !== undefined) prefill[f.key] = String(v);
        });
      }
      setValues(prefill);
      setDate(new Date().toISOString().slice(0, 10));
    }
  }, [visible, lastEntry]);

  const canSave = Object.values(values).some((v) => v && Number(v) > 0);

  const submit = () => {
    if (!canSave) return;
    const entry: MeasurementEntry = {
      id: makeId(),
      date: new Date(date).toISOString(),
    };
    MEASUREMENT_FIELDS.forEach((f) => {
      const v = values[f.key];
      if (v && !isNaN(Number(v)) && Number(v) > 0) {
        (entry as any)[f.key] = Number(v);
      }
    });
    onSave(entry);
    onClose();
  };

  return (
    <BottomDrawer visible={visible} onClose={onClose}>
      <View style={styles.addHeader}>
        <View style={[styles.addIcon, { backgroundColor: 'rgba(6,182,212,0.18)' }]}>
          <Feather name="maximize-2" size={16} color="#06b6d4" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.addTitle, { color: C.foreground }]}>Log Measurements</Text>
          <Text style={[styles.addSub, { color: C.textMuted }]}>Fill in what you measured ({unit})</Text>
        </View>
        <TouchableOpacity onPress={onClose} style={[styles.closeBtn, { backgroundColor: C.closeBtn }]}>
          <Feather name="x" size={15} color={C.foreground} />
        </TouchableOpacity>
      </View>
      <ScrollView
        style={{ flexGrow: 0, flexShrink: 1, maxHeight: winH * 0.65 }}
        contentContainerStyle={{ paddingHorizontal: Spacing.xl, paddingBottom: 16 }}
        showsVerticalScrollIndicator={true}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[styles.mGroupLabel, { color: C.textMuted, marginBottom: 6 }]}>DATE</Text>
        <TextInput
          value={date}
          onChangeText={setDate}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={C.textDim}
          style={[styles.mDateInput, { backgroundColor: C.muted, borderColor: C.border, color: C.foreground }]}
        />

        {MEASUREMENT_GROUPS.map((group) => (
          <View key={group} style={{ marginTop: Spacing.lg }}>
            <Text style={[styles.mGroupLabel, { color: C.textDim }]}>{group.toUpperCase()}</Text>
            <View style={{ gap: 8, marginTop: 8 }}>
              {MEASUREMENT_FIELDS.filter((f) => f.group === group).map((f) => (
                <View key={f.key} style={styles.mInputRow}>
                  <View style={[styles.mDot, { backgroundColor: f.color }]} />
                  <Text style={[styles.mInputLabel, { color: C.foreground }]} numberOfLines={1}>{f.label}</Text>
                  <View style={{ flex: 1 }}>
                    <TextInput
                      value={values[f.key] || ''}
                      onChangeText={(t) => setValues((p) => ({ ...p, [f.key]: t }))}
                      keyboardType="decimal-pad"
                      placeholder="—"
                      placeholderTextColor={C.textDim}
                      style={[
                        styles.mInput,
                        {
                          backgroundColor: C.muted,
                          borderColor: values[f.key] ? `${f.color}66` : C.border,
                          color: C.foreground,
                        },
                      ]}
                    />
                    <Text style={[styles.mInputUnit, { color: C.textDim }]}>{unit}</Text>
                  </View>
                </View>
              ))}
            </View>
          </View>
        ))}
      </ScrollView>
      <View style={{ paddingHorizontal: Spacing.xl, paddingTop: Spacing.md, paddingBottom: Spacing.xl, borderTopWidth: 1, borderTopColor: C.borderSubtle }}>
        <TouchableOpacity
          onPress={submit}
          disabled={!canSave}
          style={[styles.saveBtn, { backgroundColor: Colors.primary, opacity: canSave ? 1 : 0.4 }]}
          activeOpacity={0.8}
        >
          <Feather name="check" size={14} color={Colors.primaryFg} />
          <Text style={[styles.saveBtnText, { color: Colors.primaryFg }]}>Save Measurements</Text>
        </TouchableOpacity>
      </View>
    </BottomDrawer>
  );
}

function BodyMeasurementsCard({ chartWidth }: { chartWidth: number }) {
  const { C } = useTheme();
  const [data, setData] = useState<MeasurementsData>({ entries: [], unit: 'cm' });
  const [selectedKey, setSelectedKey] = useState<MeasurementKey>('chest');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => {
    loadMeasurements().then(setData);
  }, []);

  const update = async (next: MeasurementsData) => {
    setData(next);
    await saveMeasurements(next);
  };

  const toggleUnit = () => update({ ...data, unit: data.unit === 'cm' ? 'in' : 'cm' });

  const addEntry = (entry: MeasurementEntry) => {
    const entries = [entry, ...data.entries].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );
    update({ ...data, entries });
  };

  const deleteEntry = (id: string) => {
    update({ ...data, entries: data.entries.filter((e) => e.id !== id) });
  };

  const latestValues = useMemo(() => {
    const result: Record<string, { current: number; change?: number; totalChange?: number }> = {};
    MEASUREMENT_FIELDS.forEach((f) => {
      const withVal = data.entries.filter((e) => e[f.key] !== undefined);
      if (withVal.length > 0) {
        const current = withVal[0][f.key] as number;
        const previous = withVal.length > 1 ? (withVal[1][f.key] as number) : undefined;
        const first = withVal.length > 1 ? (withVal[withVal.length - 1][f.key] as number) : undefined;
        result[f.key] = {
          current,
          change: previous !== undefined ? Number((current - previous).toFixed(1)) : undefined,
          totalChange: first !== undefined ? Number((current - first).toFixed(1)) : undefined,
        };
      }
    });
    return result;
  }, [data.entries]);

  const selectedField = MEASUREMENT_FIELDS.find((f) => f.key === selectedKey)!;
  const selectedVal = latestValues[selectedKey];

  const chartSeries = useMemo(() => {
    const points = data.entries
      .slice()
      .reverse()
      .filter((e) => e[selectedKey] !== undefined)
      .map((e) => ({ date: e.date, value: e[selectedKey] as number }));
    return {
      data: points.map((p) => p.value),
      labels: points.map((p) => formatDateShort(p.date)),
    };
  }, [data.entries, selectedKey]);

  const hasEntries = data.entries.length > 0;
  const lastEntry = data.entries[0];

  return (
    <View>
      {/* Header: unit toggle + Log button */}
      <View style={styles.mHeaderRow}>
        <View style={[styles.mUnitToggle, { backgroundColor: C.muted, borderColor: C.border }]}>
          {(['cm', 'in'] as const).map((u) => {
            const active = data.unit === u;
            return (
              <TouchableOpacity
                key={u}
                onPress={() => data.unit !== u && toggleUnit()}
                style={[styles.mUnitPill, active && { backgroundColor: Colors.primary }]}
              >
                <Text style={[styles.mUnitText, { color: active ? Colors.primaryFg : C.textMuted }]}>{u}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <TouchableOpacity
          onPress={() => setLogOpen(true)}
          style={[styles.mLogBtn, { backgroundColor: Colors.primary }]}
          activeOpacity={0.8}
        >
          <Feather name="plus" size={12} color={Colors.primaryFg} />
          <Text style={[styles.mLogBtnText, { color: Colors.primaryFg }]}>Log</Text>
        </TouchableOpacity>
      </View>

      {!hasEntries ? (
        <View style={[styles.mEmptyCard, { backgroundColor: C.card, borderColor: C.borderSubtle }, Shadow.card]}>
          <View style={[styles.mEmptyIcon, { backgroundColor: C.muted }]}>
            <Feather name="maximize-2" size={22} color={C.textDim} />
          </View>
          <Text style={[styles.mEmptyTitle, { color: C.foreground }]}>No measurements yet</Text>
          <Text style={[styles.mEmptySub, { color: C.textMuted }]}>Track your body changes over time</Text>
          <TouchableOpacity
            onPress={() => setLogOpen(true)}
            style={[styles.mEmptyBtn, { backgroundColor: Colors.primary }]}
            activeOpacity={0.8}
          >
            <Feather name="plus" size={12} color={Colors.primaryFg} />
            <Text style={[styles.mEmptyBtnText, { color: Colors.primaryFg }]}>Log First Measurement</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={[styles.mMainCard, { backgroundColor: C.card, borderColor: C.borderSubtle }, Shadow.card]}>
          {/* Dropdown selector */}
          <TouchableOpacity
            onPress={() => setDropdownOpen((v) => !v)}
            style={styles.mSelectorRow}
            activeOpacity={0.7}
          >
            <View style={[styles.mSelectorDot, { backgroundColor: selectedField.color }]} />
            <Text style={[styles.mSelectorLabel, { color: C.foreground }]}>{selectedField.label}</Text>
            {selectedVal && (
              <Text style={[styles.mSelectorValue, { color: C.foreground }]}>
                {selectedVal.current}
                <Text style={[styles.mSelectorUnit, { color: C.textDim }]}> {data.unit}</Text>
              </Text>
            )}
            <Feather name={dropdownOpen ? 'chevron-up' : 'chevron-down'} size={16} color={C.textMuted} />
          </TouchableOpacity>

          {dropdownOpen && (
            <View style={[styles.mDropdownPanel, { backgroundColor: C.muted, borderColor: C.borderSubtle }]}>
              <ScrollView style={{ maxHeight: 240 }} showsVerticalScrollIndicator={false}>
                {MEASUREMENT_GROUPS.map((group) => {
                  const fields = MEASUREMENT_FIELDS.filter((f) => f.group === group && latestValues[f.key]);
                  if (fields.length === 0) return null;
                  return (
                    <View key={group}>
                      <Text style={[styles.mGroupHeader, { color: C.textDim, borderBottomColor: C.borderSubtle }]}>
                        {group.toUpperCase()}
                      </Text>
                      {fields.map((f) => {
                        const v = latestValues[f.key];
                        const active = selectedKey === f.key;
                        return (
                          <TouchableOpacity
                            key={f.key}
                            onPress={() => { setSelectedKey(f.key); setDropdownOpen(false); }}
                            style={[
                              styles.mDropdownItem,
                              { borderLeftColor: active ? f.color : 'transparent', backgroundColor: active ? `${f.color}12` : 'transparent' },
                            ]}
                          >
                            <View style={[styles.mDot, { backgroundColor: f.color }]} />
                            <Text style={[styles.mDropdownItemLabel, { color: C.foreground }]} numberOfLines={1}>{f.label}</Text>
                            <Text style={[styles.mDropdownItemValue, { color: C.foreground }]}>{v.current}</Text>
                            {v.change !== undefined && v.change !== 0 && (
                              <Text style={[styles.mDropdownItemChange, { color: v.change > 0 ? '#10b981' : '#ef4444' }]}>
                                {v.change > 0 ? '+' : ''}{v.change}
                              </Text>
                            )}
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  );
                })}
              </ScrollView>
            </View>
          )}

          {/* Stats row */}
          {selectedVal && (
            <View style={styles.mStatsRow}>
              {selectedVal.change !== undefined && selectedVal.change !== 0 && (
                <View style={[styles.mStatBadge, { backgroundColor: selectedVal.change > 0 ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)' }]}>
                  <Feather name={selectedVal.change > 0 ? 'trending-up' : 'trending-down'} size={10} color={selectedVal.change > 0 ? '#10b981' : '#ef4444'} />
                  <Text style={[styles.mStatBadgeText, { color: selectedVal.change > 0 ? '#10b981' : '#ef4444' }]}>
                    {selectedVal.change > 0 ? '+' : ''}{selectedVal.change} last
                  </Text>
                </View>
              )}
              {selectedVal.totalChange !== undefined && selectedVal.totalChange !== 0 && (
                <View style={[styles.mStatBadge, { backgroundColor: selectedVal.totalChange > 0 ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)' }]}>
                  <Feather name={selectedVal.totalChange > 0 ? 'trending-up' : 'trending-down'} size={10} color={selectedVal.totalChange > 0 ? '#10b981' : '#ef4444'} />
                  <Text style={[styles.mStatBadgeText, { color: selectedVal.totalChange > 0 ? '#10b981' : '#ef4444' }]}>
                    {selectedVal.totalChange > 0 ? '+' : ''}{selectedVal.totalChange} total
                  </Text>
                </View>
              )}
              <Text style={[styles.mEntryCount, { color: C.textDim, marginLeft: 'auto' }]}>
                {chartSeries.data.length} {chartSeries.data.length === 1 ? 'entry' : 'entries'}
              </Text>
            </View>
          )}

          {/* Chart */}
          {chartSeries.data.length >= 2 ? (
            <View style={{ marginTop: Spacing.md, marginHorizontal: -4 }}>
              <MiniAreaChart
                data={chartSeries.data}
                labels={chartSeries.labels}
                width={chartWidth}
                height={130}
                color={selectedField.color}
                valueSuffix={data.unit}
                tooltipBgColor={C.elevated}
                tooltipTextColor={C.foreground}
              />
            </View>
          ) : (
            <View style={styles.mChartEmpty}>
              <Text style={[styles.mChartEmptyText, { color: C.textMuted }]}>
                Log one more entry to see the progress chart
              </Text>
            </View>
          )}

          {/* Show history */}
          <TouchableOpacity
            onPress={() => setHistoryOpen(true)}
            style={[styles.showHistoryBtn, { borderTopColor: C.borderSubtle }]}
          >
            <Feather name="calendar" size={10} color={C.accentText} />
            <Text style={[styles.showHistoryText, { color: C.accentText }]}>
              Show history ({data.entries.length})
            </Text>
          </TouchableOpacity>
        </View>
      )}

      <LogMeasurementsDrawer
        visible={logOpen}
        onClose={() => setLogOpen(false)}
        unit={data.unit}
        lastEntry={lastEntry}
        onSave={addEntry}
      />
      <MeasurementHistoryDrawer
        visible={historyOpen}
        onClose={() => setHistoryOpen(false)}
        data={data}
        onDelete={deleteEntry}
      />
    </View>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getWeekStart() {
  const now = new Date();
  const day = now.getDay();
  const diff = (day + 6) % 7;
  const start = new Date(now);
  start.setDate(now.getDate() - diff);
  start.setHours(0, 0, 0, 0);
  return start;
}

function get6WeekVolume(workouts: WorkoutRaw[]): { data: number[]; labels: string[] } {
  const weeks: number[] = [];
  const labels: string[] = [];
  for (let i = 5; i >= 0; i--) {
    const start = new Date();
    start.setDate(start.getDate() - start.getDay() + 1 - i * 7);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    const vol = workouts
      .filter((w) => {
        const t = new Date(w.started_at).getTime();
        return t >= start.getTime() && t < end.getTime();
      })
      .reduce((s, w) => s + (w.total_volume_kg || 0), 0);
    weeks.push(vol);
    labels.push(`W${6 - i}`);
  }
  return { data: weeks, labels };
}

function get7DayDuration(workouts: WorkoutRaw[]): { data: number[]; labels: string[] } {
  const data: number[] = [];
  const labels: string[] = [];
  const today = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const ds = d.toDateString();
    const minutes = workouts
      .filter((w) => new Date(w.started_at).toDateString() === ds)
      .reduce((s, w) => s + (w.duration_seconds || 0), 0) / 60;
    data.push(Math.round(minutes));
    labels.push(['S', 'M', 'T', 'W', 'T', 'F', 'S'][d.getDay()]);
  }
  return { data, labels };
}

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function AnalyticsScreen() {
  const { C } = useTheme();
  const { user, isLoaded: clerkLoaded } = useClerkUser();
  const isGuestSession = useIsGuestSession();
  const supabase = useSupabaseClient();
  const { pendingCount } = useSync();
  const { width: winWidth } = useWindowDimensions();
  const bigChartWidth = winWidth - Spacing.xl * 2 - Spacing.lg * 2;
  const [workouts, setWorkouts] = useState<WorkoutRaw[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [selectedExercise, setSelectedExercise] = useState('');
  const [chartMode, setChartMode] = useState<'weight' | 'volume'>('weight');

  // AI Insights
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [insights, setInsights] = useState<string[]>([]);

  // Body stats
  const [weightLog, setWeightLog] = useState<WeightEntry[]>([]);
  const [bodyFatLog, setBodyFatLog] = useState<BodyFatEntry[]>([]);
  const { goalWeight: ctxGoal, weightUnit } = useBasicInfo();
  const goalWeight = ctxGoal ?? null;
  const [addWeightOpen, setAddWeightOpen] = useState(false);
  const [addBfOpen, setAddBfOpen] = useState(false);

  const fetchData = useCallback(async () => {
    const apply = (list: WorkoutRaw[]) => {
      setWorkouts(list);
      const all = [...new Set(
        list.flatMap((w) => w.workout_sets || []).map((s) => s.exercises?.name).filter(Boolean) as string[]
      )];
      setSelectedExercise((prev) => prev || all[0] || '');
    };

    if (isGuestSession) {
      apply(getGuestWorkoutsDetailed() as any[]);
      return;
    }

    const clerkId = user?.id;
    // Prepend not-yet-synced workouts so charts include a just-finished offline
    // session, deduped against server rows by client_id.
    const withPending = (base: WorkoutRaw[]): WorkoutRaw[] => {
      const ids = new Set(base.map((w: any) => w?.client_id).filter(Boolean));
      const pending = clerkId
        ? getPendingWorkouts(clerkId).filter((e) => !ids.has(e.clientId))
        : [];
      return [...pending.map(pendingToDashboardWorkout), ...base] as WorkoutRaw[];
    };

    await hydrateCache(clerkId);
    const cached = readCache<WorkoutRaw[]>('analyticsWorkouts', clerkId);
    // Apply pending even with no cache yet (fresh login), so a just-finished
    // offline workout appears in the charts immediately.
    const mergedCached = withPending(cached ?? []);
    if (cached || mergedCached.length > 0) apply(mergedCached);
    // Clear the spinner after the cache read; the network revalidation below
    // runs in the background and must not hold the spinner (offline it hangs).
    setLoading(false);

    const sinceIso = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
    let q = supabase
      .from('workouts')
      .select('*, workout_sets(*, exercises(*))')
      .gte('started_at', sinceIso)
      .order('started_at', { ascending: false });
    if (clerkId) q = q.eq('user_id', clerkId);
    try {
      const { data, error } = await q;
      if (error) throw error;
      const fresh = (data as WorkoutRaw[]) || [];
      writeCache('analyticsWorkouts', clerkId, fresh);
      apply(withPending(fresh));
    } catch {
      // Offline — keep the cache-first + pending view.
    }
  }, [user?.id, isGuestSession]);

  useEffect(() => {
    // Mid-hydration Clerk has no user yet, so isGuestSession reads true and a
    // signed-in user would flash empty guest analytics on cold launch.
    // Hold the spinner until Clerk settles; the effect re-runs when it does.
    if (!clerkLoaded) return;
    fetchData().finally(() => setLoading(false));
    loadWeightLog().then(setWeightLog);
    loadBodyFatLog().then(setBodyFatLog);
  }, [fetchData, clerkLoaded, pendingCount]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchData();
    const [wl, bfl] = await Promise.all([loadWeightLog(), loadBodyFatLog()]);
    setWeightLog(wl);
    setBodyFatLog(bfl);
    setRefreshing(false);
  }, [fetchData]);

  // ── Stats ──
  const weekStart = getWeekStart();
  const weekWorkouts = workouts.filter((w) => new Date(w.started_at) >= weekStart);
  const weekVolume = roundVolume(weekWorkouts.reduce((s, w) => s + (w.total_volume_kg || 0), 0));
  const avgDurationMin = workouts.length > 0
    ? Math.round(workouts.reduce((s, w) => s + (w.duration_seconds || 0), 0) / workouts.length / 60)
    : 0;
  const weekSets = weekWorkouts.reduce((s, w) => s + (w.workout_sets?.length || 0), 0);
  const weekReps = weekWorkouts.reduce(
    (s, w) => s + (w.workout_sets?.reduce((r, set) => r + (set.reps || 0), 0) || 0), 0
  );

  const volumeSeries = useMemo(() => get6WeekVolume(workouts), [workouts]);
  const durationSeries = useMemo(() => get7DayDuration(workouts), [workouts]);

  const allExerciseNames = useMemo(() => [...new Set(
    workouts.flatMap((w) => w.workout_sets || []).map((s) => s.exercises?.name).filter(Boolean) as string[]
  )].sort(), [workouts]);

  const exerciseSessionData = useMemo(() => {
    if (!selectedExercise) return { data: [] as number[], labels: [] as string[], weights: [] as number[] };
    const sessions = workouts.slice().reverse();
    const byDate: { date: string; weight: number; volume: number }[] = [];
    sessions.forEach((w) => {
      const sets = (w.workout_sets || []).filter((s) => s.exercises?.name === selectedExercise);
      if (sets.length === 0) return;
      const maxWeight = Math.max(...sets.map((s) => s.weight_kg || 0));
      const volume = sets.reduce((v, s) => v + (s.weight_kg || 0) * (s.reps || 0), 0);
      byDate.push({ date: w.started_at, weight: maxWeight, volume });
    });
    const recent = byDate.slice(-10);
    return {
      data: recent.map((p) => chartMode === 'weight' ? p.weight : p.volume),
      labels: recent.map((p) => formatDateShort(p.date)),
      weights: recent.map((p) => p.weight),
    };
  }, [workouts, selectedExercise, chartMode]);

  const pr = exerciseSessionData.weights.length > 0 ? Math.max(...exerciseSessionData.weights) : null;

  // ── Personal records ──
  const personalRecords = useMemo(() => {
    const prMap: Record<string, { max: number; trend: number }> = {};
    allExerciseNames.forEach((name) => {
      const sessions: { date: string; weight: number }[] = [];
      workouts.slice().reverse().forEach((w) => {
        const sets = (w.workout_sets || []).filter((s) => s.exercises?.name === name);
        if (sets.length > 0) {
          sessions.push({ date: w.started_at, weight: Math.max(...sets.map((s) => s.weight_kg || 0)) });
        }
      });
      if (sessions.length > 0) {
        const max = Math.max(...sessions.map((s) => s.weight));
        const trend = sessions.length >= 2 ? sessions[sessions.length - 1].weight - sessions[sessions.length - 2].weight : 0;
        prMap[name] = { max, trend };
      }
    });
    return Object.entries(prMap).sort((a, b) => b[1].max - a[1].max).slice(0, 6);
  }, [workouts, allExerciseNames]);

  // ── Handlers ──
  const addWeight = async (v: number) => {
    const today = new Date().toISOString().slice(0, 10);
    const filtered = weightLog.filter((e) => e.date.slice(0, 10) !== today);
    const next = [...filtered, { date: new Date().toISOString(), weight: v }].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );
    setWeightLog(next);
    await saveWeightLog(next);
  };

  const deleteWeight = async (date: string) => {
    const next = weightLog.filter((e) => e.date !== date);
    setWeightLog(next);
    await saveWeightLog(next);
  };

  const addBodyFat = async (v: number) => {
    const today = new Date().toISOString().slice(0, 10);
    const filtered = bodyFatLog.filter((e) => e.date.slice(0, 10) !== today);
    const next = [...filtered, { date: new Date().toISOString(), bodyFat: v }].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );
    setBodyFatLog(next);
    await saveBodyFatLog(next);
  };

  const deleteBodyFat = async (date: string) => {
    const next = bodyFatLog.filter((e) => e.date !== date);
    setBodyFatLog(next);
    await saveBodyFatLog(next);
  };

  const runAnalyze = async () => {
    setInsightsOpen(true);
    setAiLoading(true);
    setInsights([]);
    await new Promise((r) => setTimeout(r, 1200));
    const stats: string[] = [];
    if (weekWorkouts.length > 0) stats.push(`You've completed ${weekWorkouts.length} workouts this week — great consistency.`);
    if (weekVolume > 0) stats.push(`Weekly volume is ${weekVolume >= 1000 ? `${(weekVolume / 1000).toFixed(1)}k` : weekVolume}kg. Try adding one more set per exercise next week.`);
    if (pr) stats.push(`Your current PR on ${selectedExercise} is ${pr}kg. Aim for a small 2.5kg increase next session.`);
    if (avgDurationMin > 0) stats.push(`Your average session is ${avgDurationMin} minutes — balanced for hypertrophy and recovery.`);
    if (stats.length === 0) stats.push('Log a few workouts to unlock personalized insights from Coach Drona.');
    setInsights(stats);
    setAiLoading(false);
  };

  const weightEntries = weightLog.map((e) => ({ date: e.date, value: e.weight }));
  const bfEntries = bodyFatLog.map((e) => ({ date: e.date, value: e.bodyFat }));

  const hasAny = workouts.length > 0 || weightLog.length > 0 || bodyFatLog.length > 0;

  if (loading) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: C.background }]} edges={['top']}>
        <ActivityIndicator color={Colors.primary} style={{ marginTop: 60 }} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: C.background }]} edges={['top']}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 120 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={Colors.primary} colors={[Colors.primary]} />}
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={[styles.screenTitle, { color: C.foreground }]}>Analytics</Text>
          <Text style={[styles.screenSub, { color: C.mutedFg }]}>Track your progress over time</Text>
        </View>

        {!hasAny ? (
          <View style={styles.emptyState}>
            <View style={[styles.emptyIcon, { backgroundColor: C.card }]}>
              <Feather name="bar-chart-2" size={24} color={C.textDim} />
            </View>
            <Text style={[styles.emptyTitle, { color: C.textMuted }]}>No data yet</Text>
            <Text style={[styles.emptyHint, { color: C.textDim }]}>Complete workouts or log body stats to see analytics</Text>
          </View>
        ) : (
          <View style={{ paddingHorizontal: Spacing.xl, gap: Spacing.md }}>
            {/* 1. AI Coaching Insights */}
            {workouts.length > 0 && (
              <Animated.View
                entering={FadeInDown.duration(350)}
                style={[styles.aiCard, { backgroundColor: C.card, borderColor: C.borderSubtle }, Shadow.card]}
              >
                <TouchableOpacity
                  onPress={insightsOpen ? () => setInsightsOpen(false) : runAnalyze}
                  disabled={aiLoading}
                  style={styles.aiRow}
                  activeOpacity={0.7}
                >
                  <View style={[styles.aiIcon, { backgroundColor: C.primaryMuted }]}>
                    <Feather name="star" size={15} color={C.accentText} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.aiTitle, { color: C.foreground }]}>Insights from Coach Drona</Text>
                  </View>
                  {aiLoading ? (
                    <ActivityIndicator color={C.accentText} size="small" />
                  ) : (
                    <Text style={[styles.aiAction, { color: C.accentText }]}>
                      {insightsOpen ? 'Hide' : 'Analyze'}
                    </Text>
                  )}
                </TouchableOpacity>
                {insightsOpen && !aiLoading && insights.length > 0 && (
                  <Animated.View entering={FadeInDown.duration(200)} style={[styles.aiInsights, { borderTopColor: C.borderSubtle }]}>
                    {insights.map((line, i) => (
                      <View key={i} style={styles.insightRow}>
                        <View style={[styles.insightDot, { backgroundColor: C.primaryMuted }]}>
                          <View style={[styles.insightDotInner, { backgroundColor: Colors.primary }]} />
                        </View>
                        <Text style={[styles.insightText, { color: C.foreground }]}>{line}</Text>
                      </View>
                    ))}
                  </Animated.View>
                )}
                {insightsOpen && aiLoading && (
                  <View style={[styles.aiInsights, { borderTopColor: C.borderSubtle }]}>
                    {[0, 1, 2, 3].map((i) => (
                      <View key={i} style={[styles.skeleton, { backgroundColor: C.muted, width: `${70 + i * 6}%` }]} />
                    ))}
                  </View>
                )}
              </Animated.View>
            )}

            {/* 2. Volume + Duration */}
            {workouts.length > 0 && (
              <View style={styles.row2}>
                <MiniAreaCard
                  icon="trending-up"
                  label="Volume"
                  value={weekVolume >= 1000 ? `${(weekVolume / 1000).toFixed(1)}k` : String(weekVolume)}
                  suffix="kg"
                  color="#06b6d4"
                  data={volumeSeries.data}
                  labels={volumeSeries.labels}
                  valueSuffix="kg"
                />
                <MiniAreaCard
                  icon="clock"
                  label="Duration"
                  value={String(avgDurationMin)}
                  suffix="min avg"
                  color="#a855f7"
                  data={durationSeries.data}
                  labels={durationSeries.labels}
                  valueSuffix="min"
                />
              </View>
            )}

            {/* 3. Sets + Reps */}
            {workouts.length > 0 && (
              <View style={styles.row2}>
                <StatMiniCard
                  icon="target"
                  label="Sets"
                  value={weekSets}
                  suffix="this week"
                  color="#10b981"
                  progress={weekSets / 50}
                  target="Target: 50/week"
                />
                <StatMiniCard
                  icon="zap"
                  label="Reps"
                  value={weekReps}
                  suffix="this week"
                  color="#f59e0b"
                  progress={weekReps / 500}
                  target="Target: 500/week"
                />
              </View>
            )}

            {/* 4. Exercise Progress */}
            {allExerciseNames.length > 0 && (
              <View style={[styles.bigCard, { backgroundColor: C.card, borderColor: C.borderSubtle }, Shadow.card]}>
                <View style={[styles.cardGlow, { backgroundColor: Colors.primary, opacity: 0.04 }]} />
                <View style={styles.trendHeader}>
                  <View style={styles.trendHeaderLeft}>
                    <Feather name="trending-up" size={14} color={Colors.primary} />
                    <Text style={[styles.trendTitle, { color: C.foreground }]}>Exercise Progress</Text>
                  </View>
                  {pr != null && (
                    <View style={[styles.prBadge, { backgroundColor: C.primaryMuted }]}>
                      <Feather name="award" size={11} color={C.accentText} />
                      <Text style={[styles.prText, { color: C.accentText }]}>PR: {pr}kg</Text>
                    </View>
                  )}
                </View>

                <View style={{ marginTop: Spacing.md, marginBottom: Spacing.md, zIndex: 100 }}>
                  <ExerciseDropdown
                    exercises={allExerciseNames}
                    selected={selectedExercise}
                    onSelect={setSelectedExercise}
                  />
                </View>

                <View style={{ alignSelf: 'flex-start', marginBottom: Spacing.md }}>
                  <SegmentedToggle
                    options={[{ key: 'weight', label: 'Max Weight' }, { key: 'volume', label: 'Volume' }]}
                    selected={chartMode}
                    onSelect={(v) => setChartMode(v as any)}
                  />
                </View>

                {exerciseSessionData.data.length === 0 ? (
                  <View style={styles.emptyTrend}>
                    <Feather name="bar-chart-2" size={28} color={C.textDim} />
                    <Text style={[styles.emptyText, { color: C.textMuted }]}>
                      No data for {selectedExercise}
                    </Text>
                  </View>
                ) : exerciseSessionData.data.length === 1 ? (
                  <View style={styles.emptyTrend}>
                    <Text style={[styles.singleValue, { color: C.accentText }]}>
                      {exerciseSessionData.data[0]}{chartMode === 'weight' ? 'kg' : ''}
                    </Text>
                    <Text style={[styles.emptyHint, { color: C.textDim }]}>Log more to see a trend</Text>
                  </View>
                ) : (
                  <View>
                    <MiniAreaChart
                      data={exerciseSessionData.data}
                      labels={exerciseSessionData.labels}
                      width={bigChartWidth}
                      height={140}
                      color={Colors.primary}
                      valueSuffix={chartMode === 'weight' ? 'kg' : ''}
                      tooltipBgColor={C.elevated}
                      tooltipTextColor={C.foreground}
                    />
                  </View>
                )}
              </View>
            )}

            {/* 5. Weight Trend */}
            <TrendCard
              title="Weight Trend"
              icon="trending-up"
              color="#10b981"
              unit={weightUnit}
              log={weightEntries}
              goal={goalWeight}
              chartWidth={bigChartWidth}
              onAdd={() => setAddWeightOpen(true)}
              onDelete={deleteWeight}
              onRefreshLog={() => {}}
            />

            {/* 6. Body Fat Trend */}
            <TrendCard
              title="Body Fat %"
              icon="activity"
              color="#ef4444"
              unit="%"
              log={bfEntries}
              chartWidth={bigChartWidth}
              onAdd={() => setAddBfOpen(true)}
              onDelete={deleteBodyFat}
              onRefreshLog={() => {}}
            />

            {/* 7. Body Measurements */}
            <View style={styles.sectionLabel}>
              <Feather name="maximize-2" size={12} color={C.textMuted} />
              <Text style={[styles.sectionLabelText, { color: C.textMuted }]}>BODY MEASUREMENTS</Text>
            </View>
            <BodyMeasurementsCard chartWidth={bigChartWidth} />

            {/* 8. Personal Records */}
            {personalRecords.length > 0 && (
              <View style={[styles.bigCard, { backgroundColor: C.card, borderColor: C.borderSubtle }, Shadow.card]}>
                <View style={styles.trendHeader}>
                  <View style={styles.trendHeaderLeft}>
                    <Feather name="award" size={14} color="#f59e0b" />
                    <Text style={[styles.trendTitle, { color: C.foreground }]}>Personal Records</Text>
                  </View>
                </View>
                <View style={{ marginTop: Spacing.sm }}>
                  {personalRecords.map(([name, { max, trend }], i) => (
                    <View
                      key={name}
                      style={[
                        styles.prRow,
                        { borderBottomColor: C.borderSubtle, borderBottomWidth: i === personalRecords.length - 1 ? 0 : 1 },
                      ]}
                    >
                      <Text style={[styles.prName, { color: C.foreground }]} numberOfLines={1}>{name}</Text>
                      <View style={styles.prRight}>
                        {trend !== 0 && (
                          <Text style={[styles.prTrend, { color: trend > 0 ? '#10b981' : '#ef4444' }]}>
                            {trend > 0 ? '+' : ''}{trend}kg
                          </Text>
                        )}
                        <Text style={[styles.prMax, { color: C.accentText }]}>{max}kg</Text>
                      </View>
                    </View>
                  ))}
                </View>
              </View>
            )}
          </View>
        )}
      </ScrollView>

      {/* Add Entry modals */}
      <AddEntryModal
        visible={addWeightOpen}
        onClose={() => setAddWeightOpen(false)}
        title="Log Weight"
        label="Weight"
        unit={weightUnit}
        color="#10b981"
        icon="trending-up"
        initial={weightLog.length > 0 ? String(weightLog[weightLog.length - 1].weight) : ''}
        onSave={addWeight}
      />
      <AddEntryModal
        visible={addBfOpen}
        onClose={() => setAddBfOpen(false)}
        title="Log Body Fat"
        label="Body Fat"
        unit="%"
        color="#ef4444"
        icon="activity"
        initial={bodyFatLog.length > 0 ? String(bodyFatLog[bodyFatLog.length - 1].bodyFat) : ''}
        onSave={addBodyFat}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },

  header: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.lg,
  },
  screenTitle: { fontSize: FontSize.xxl, fontWeight: FontWeight.black, letterSpacing: -0.5 },
  screenSub: { fontSize: FontSize.sm, marginTop: 3 },

  emptyState: { alignItems: 'center', paddingVertical: 80, paddingHorizontal: Spacing.xxl },
  emptyIcon: { width: 64, height: 64, borderRadius: Radius.xxl, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.lg },
  emptyTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  emptyHint: { fontSize: FontSize.xs, marginTop: 4, textAlign: 'center' },

  // Rows
  row2: { flexDirection: 'row', gap: 10 },

  // Mini card
  miniCard: {
    flex: 1,
    borderRadius: Radius.xl,
    borderWidth: 1,
    padding: Spacing.md,
    position: 'relative',
    overflow: 'hidden',
  },
  cardGlow: {
    position: 'absolute',
    top: -30, right: -30,
    width: 100, height: 100,
    borderRadius: 50,
  },
  miniHeader: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 4 },
  miniLabel: { fontSize: 10, fontWeight: FontWeight.black, letterSpacing: 0.8 },
  miniValueRow: { flexDirection: 'row', alignItems: 'baseline', marginBottom: 4 },
  miniValue: { fontSize: 22, fontWeight: FontWeight.black, letterSpacing: -0.5 },
  miniSuffix: { fontSize: 10, fontWeight: FontWeight.medium, marginLeft: 2 },
  noDataMini: { height: 68, alignItems: 'center', justifyContent: 'center' },
  noDataText: { fontSize: 10 },

  targetText: { fontSize: 9, marginTop: 3 },
  barTrack: { height: 6, borderRadius: 3, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 3 },

  // Big card (trend, exercise progress, PRs, measurements)
  bigCard: {
    borderRadius: Radius.xl,
    borderWidth: 1,
    padding: Spacing.lg,
    position: 'relative',
    overflow: 'hidden',
  },

  // AI card
  aiCard: {
    borderRadius: Radius.xl,
    borderWidth: 1,
    overflow: 'hidden',
  },
  aiRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 14,
  },
  aiIcon: { width: 36, height: 36, borderRadius: Radius.md, alignItems: 'center', justifyContent: 'center' },
  aiTitle: { fontSize: FontSize.base, fontWeight: FontWeight.bold },
  aiSub: { fontSize: 10, marginTop: 2 },
  aiAction: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  aiInsights: { borderTopWidth: 1, padding: Spacing.lg, gap: 12 },
  insightRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  insightDot: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  insightDotInner: { width: 6, height: 6, borderRadius: 3 },
  insightText: { flex: 1, fontSize: FontSize.sm, lineHeight: 20 },
  skeleton: { height: 14, borderRadius: 4, marginBottom: 8 },

  // Trend
  trendHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  trendHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  trendHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  trendTitle: { fontSize: FontSize.base, fontWeight: FontWeight.bold },
  trendLatest: { fontSize: FontSize.base, fontWeight: FontWeight.black },
  trendUnit: { fontSize: 10, fontWeight: FontWeight.medium },
  diffText: { fontSize: 10, fontWeight: FontWeight.bold },
  plusBtn: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },

  emptyTrend: { paddingVertical: 24, alignItems: 'center', gap: 6 },
  emptyText: { fontSize: FontSize.sm },
  singleValue: { fontSize: 26, fontWeight: FontWeight.black },
  goalLabel: { fontSize: 9, marginTop: 4, fontWeight: FontWeight.bold },

  showHistoryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderTopWidth: 1,
    marginTop: Spacing.md,
    marginHorizontal: -Spacing.lg,
    marginBottom: -Spacing.lg,
  },
  showHistoryText: { fontSize: 10, fontWeight: FontWeight.semibold },

  // Exercise Progress
  dropdownWrap: { position: 'relative', zIndex: 100 },
  dropdownBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 42,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.md,
    borderWidth: 1,
  },
  dropdownText: { fontSize: FontSize.sm, flex: 1 },
  dropdownList: {
    position: 'absolute',
    top: 46,
    left: 0, right: 0,
    borderRadius: Radius.lg,
    borderWidth: 1,
    overflow: 'hidden',
    zIndex: 200,
  },
  dropdownEmpty: { padding: Spacing.lg, textAlign: 'center', fontSize: FontSize.sm },
  dropdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  dropdownItemText: { fontSize: FontSize.sm },

  segWrap: { flexDirection: 'row', borderRadius: Radius.md, padding: 3 },
  segPill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: Radius.sm },
  segText: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold },

  prBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: Radius.full,
  },
  prText: { fontSize: 10, fontWeight: FontWeight.bold },

  // Drawer
  drawerBackdrop: { flex: 1, justifyContent: 'flex-end' },
  drawerSheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
  },
  drawerHandle: {
    width: 40, height: 4, borderRadius: 2, alignSelf: 'center',
    marginTop: 10, marginBottom: 4,
  },

  addHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
  },
  addIcon: { width: 36, height: 36, borderRadius: Radius.md, alignItems: 'center', justifyContent: 'center' },
  addTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  addSub: { fontSize: 10, marginTop: 2 },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },

  fieldLabel: { fontSize: 11, fontWeight: FontWeight.semibold, marginBottom: 6, letterSpacing: 0.5 },
  textInput: {
    height: 52,
    borderRadius: Radius.md,
    borderWidth: 1,
    paddingHorizontal: Spacing.lg,
    fontSize: FontSize.lg,
    fontWeight: FontWeight.semibold,
    marginBottom: Spacing.md,
  },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 48,
    borderRadius: Radius.md,
  },
  saveBtnText: { fontSize: FontSize.base, fontWeight: FontWeight.bold },

  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: Spacing.lg,
    borderRadius: Radius.lg,
    borderWidth: 1,
  },
  historyDate: { fontSize: FontSize.sm, fontWeight: FontWeight.medium },
  historyRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  diffBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: Radius.full },
  historyValue: { fontSize: FontSize.base, fontWeight: FontWeight.black },
  historyUnit: { fontSize: 10, fontWeight: FontWeight.medium },
  deleteBtn: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },

  // Measurements — new Figma-matching card
  mHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: Spacing.sm },
  mUnitToggle: { flexDirection: 'row', borderRadius: Radius.full, borderWidth: 1, overflow: 'hidden', height: 28 },
  mUnitPill: { paddingHorizontal: 12, height: '100%', alignItems: 'center', justifyContent: 'center' },
  mUnitText: { fontSize: 10, fontWeight: FontWeight.black, letterSpacing: 0.5 },
  mLogBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, paddingVertical: 6, borderRadius: Radius.md },
  mLogBtnText: { fontSize: 12, fontWeight: FontWeight.black },

  mEmptyCard: { borderRadius: Radius.xl, borderWidth: 1, padding: Spacing.xxl, alignItems: 'center' },
  mEmptyIcon: { width: 56, height: 56, borderRadius: Radius.lg, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.md },
  mEmptyTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, marginBottom: 4 },
  mEmptySub: { fontSize: FontSize.xs, marginBottom: Spacing.lg },
  mEmptyBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: Spacing.lg, paddingVertical: 10, borderRadius: Radius.md },
  mEmptyBtnText: { fontSize: 12, fontWeight: FontWeight.black },

  mMainCard: { borderRadius: Radius.xl, borderWidth: 1, padding: Spacing.lg, overflow: 'hidden' },
  mSelectorRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  mSelectorDot: { width: 12, height: 12, borderRadius: 6 },
  mSelectorLabel: { flex: 1, fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  mSelectorValue: { fontSize: FontSize.lg, fontWeight: FontWeight.black, marginRight: 4 },
  mSelectorUnit: { fontSize: 10, fontWeight: FontWeight.medium },

  mDropdownPanel: { marginTop: Spacing.md, borderRadius: Radius.md, borderWidth: 1, overflow: 'hidden' },
  mGroupHeader: { fontSize: 9, fontWeight: FontWeight.black, letterSpacing: 1.2, paddingHorizontal: Spacing.md, paddingVertical: 6, borderBottomWidth: 1 },
  mDropdownItem: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: Spacing.md, paddingVertical: 10, borderLeftWidth: 3 },
  mDropdownItemLabel: { flex: 1, fontSize: FontSize.xs, fontWeight: FontWeight.medium },
  mDropdownItemValue: { fontSize: FontSize.xs, fontWeight: FontWeight.black },
  mDropdownItemChange: { fontSize: 10, fontWeight: FontWeight.bold, minWidth: 30, textAlign: 'right' },

  mStatsRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: Spacing.md },
  mStatBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: Radius.full },
  mStatBadgeText: { fontSize: 11, fontWeight: FontWeight.bold },
  mEntryCount: { fontSize: 10, fontWeight: FontWeight.medium },

  mChartEmpty: { paddingVertical: 28, alignItems: 'center' },
  mChartEmptyText: { fontSize: 11 },

  mDot: { width: 8, height: 8, borderRadius: 4 },

  // History drawer entries
  mEntryCard: { borderRadius: Radius.lg, borderWidth: 1, padding: Spacing.md },
  mEntryHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: Spacing.sm },
  mEntryDate: { fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  mConfirmBtn: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  mEntryGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  mEntryCell: { flexDirection: 'row', alignItems: 'center', gap: 6, width: '50%', paddingVertical: 3 },
  mCellLabel: { flex: 1, fontSize: FontSize.xs },
  mCellValue: { fontSize: FontSize.xs, fontWeight: FontWeight.bold },
  mCellUnit: { fontSize: 9, fontWeight: FontWeight.regular },

  // Log drawer inputs
  mGroupLabel: { fontSize: 9, fontWeight: FontWeight.black, letterSpacing: 1.2 },
  mDateInput: {
    height: 46,
    borderRadius: Radius.md,
    borderWidth: 1,
    paddingHorizontal: Spacing.md,
    fontSize: FontSize.base,
    fontWeight: FontWeight.medium,
  },
  mInputRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  mInputLabel: { width: 96, fontSize: FontSize.xs, fontWeight: FontWeight.medium },
  mInput: {
    height: 42,
    borderRadius: Radius.md,
    borderWidth: 1,
    paddingHorizontal: Spacing.md,
    paddingRight: 32,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    textAlign: 'right',
  },
  mInputUnit: { position: 'absolute', right: 10, top: 0, bottom: 0, fontSize: 10, textAlignVertical: 'center', lineHeight: 42 },

  // Section label
  sectionLabel: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  sectionLabelText: { fontSize: 10, fontWeight: FontWeight.semibold, letterSpacing: 1.2 },

  // Personal Records
  prRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  prName: { flex: 1, fontSize: FontSize.sm, marginRight: 12 },
  prRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  prTrend: { fontSize: 10, fontWeight: FontWeight.semibold },
  prMax: { fontSize: FontSize.base, fontWeight: FontWeight.black },
});
