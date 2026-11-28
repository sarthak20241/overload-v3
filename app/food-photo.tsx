/**
 * Meal photo, full screen (photo food logging, lib/foodPhoto).
 *
 * Two steps. Camera: frame the plate and take it, with short tips that move
 * accuracy most (from above, the whole plate, something for scale). Review:
 * the photo, an optional second angle, and a note for what the camera cannot
 * see (oil, ghee, how much was eaten). The note is the biggest single lever on
 * accuracy, so the review step asks for it without making it required.
 *
 * Send leaves the photos for /nutrition (setPendingPhoto) and goes back; the
 * food box runs the parse there, so the wait, the card and corrections are the
 * ones typed food already has.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Image,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { Camera, useCameraDevice, useCameraPermission, usePhotoOutput } from 'react-native-vision-camera';

import { useTheme } from '@/hooks/useTheme';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';
import { haptics } from '@/lib/haptics';
import * as Application from 'expo-application';
import { getFlagVariant, track } from '@/lib/analytics';
import {
  FOOD_PHOTO_FLAG, PHOTO_MAX_IMAGES, photoLoggingAllowed, setPendingPhoto, type PendingPhotoMeal, type PhotoShot,
} from '@/lib/foodPhoto';
import { discardShots, preparePhoto } from '@/lib/foodPhotoCapture';

type Step = 'camera' | 'review';

const isMeal = (v: unknown): v is PendingPhotoMeal => v === 'breakfast' || v === 'lunch' || v === 'dinner' || v === 'snack';

export default function FoodPhotoScreen() {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ meal?: string; day?: string }>();
  const meal: PendingPhotoMeal = isMeal(params.meal) ? params.meal : 'snack';
  // A link's day that is not a real date ("2026-99-99", "2026-02-31") falls
  // back to today: the parsed date must read back as the same day.
  const day = useMemo(() => {
    const m = typeof params.day === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(params.day) : null;
    if (!m) return new Date();
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
    return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : new Date();
  }, [params.day]);

  // The same check as the food box's button (lib/foodPhoto), so a deep link
  // cannot open the camera on a build or account the button is hidden for:
  // an older binary's camera prompt still says nothing is uploaded.
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void getFlagVariant(FOOD_PHOTO_FLAG, 'off').then((r) => {
      if (alive) setAllowed(photoLoggingAllowed({ flag: r.variant, os: Platform.OS, build: Application.nativeBuildVersion, dev: __DEV__ }));
    });
    return () => { alive = false; };
  }, []);

  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');
  // About 12 MP: plenty for a 1568 px upload, and quick to take.
  const photoOutput = usePhotoOutput({ qualityPrioritization: 'balanced' });

  const [step, setStep] = useState<Step>('camera');
  const [shots, setShots] = useState<PhotoShot[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [permissionBlocked, setPermissionBlocked] = useState(false);
  // Shots not handed to Nutrition are removed on the way out.
  const sentRef = useRef(false);
  const shotsRef = useRef<PhotoShot[]>([]);
  shotsRef.current = shots;
  // A shot that finishes after the screen has closed is deleted, not added.
  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
    if (!sentRef.current) discardShots(shotsRef.current);
  }, []);

  const askForCamera = useCallback(async () => {
    const granted = await requestPermission();
    if (!granted) setPermissionBlocked(true);
  }, [requestPermission]);
  // Asked once on open, and only when photo logging is allowed here. After a
  // no, only the Settings button can change it.
  useEffect(() => {
    if (allowed === true && !hasPermission && !permissionBlocked) void askForCamera();
  }, [allowed, hasPermission, permissionBlocked, askForCamera]);

  const takePhoto = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    haptics.tap();
    try {
      const photo = await photoOutput.capturePhoto({ flashMode: 'off' }, {});
      const shot = await preparePhoto(photo);
      // The live list (shotsRef), not this render's copy.
      // Closed, or already sent: this shot has no owner, so it goes.
      if (!mountedRef.current || sentRef.current || shotsRef.current.length >= PHOTO_MAX_IMAGES) {
        discardShots([shot]);
        return;
      }
      setShots((prev) => [...prev, shot]);
      setStep('review');
    } catch {
      setProblem('That one did not come through. Try again.');
    } finally {
      setBusy(false);
    }
  }, [busy, photoOutput]);

  // The live list (shotsRef), so a quick double tap removes each photo once.
  const retake = useCallback((index: number) => {
    const gone = shotsRef.current[index];
    if (!gone) return;
    discardShots([gone]);
    const next = shotsRef.current.filter((s) => s.uri !== gone.uri);
    shotsRef.current = next;
    setShots(next);
    if (next.length === 0) setStep('camera');
  }, []);

  const send = useCallback(() => {
    // Once: a second tap would hand the same photos off again.
    if (!shots.length || sentRef.current) return;
    haptics.tap();
    track('meal_photo_sent', { images: shots.length, has_note: note.trim().length > 0, note_chars: note.trim().length });
    setPendingPhoto({ images: shots, note, meal, day }, Date.now(), discardShots);
    sentRef.current = true;
    router.back();
  }, [shots, note, meal, day]);

  const close = useCallback(() => router.back(), []);

  // The camera runs only while the app is in front.
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => setAppActive(st === 'active'));
    return () => sub.remove();
  }, []);

  // ── not here ───────────────────────────────────────────────────────────────

  if (allowed !== true) {
    return (
      <View style={[styles.root, { backgroundColor: '#000' }]}>
        {allowed === false && (
          <View style={styles.centered}>
            <Feather name="camera-off" size={28} color="#fff" />
            <Text style={styles.centerLead}>Meal photos aren't on in this version yet.</Text>
            <Text style={styles.centerSub}>Type what you ate in the food box and I'll log it.</Text>
            <Pressable onPress={close} style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.85 }]}>
              <Text style={styles.primaryLabel}>Back</Text>
            </Pressable>
          </View>
        )}
      </View>
    );
  }

  // ── camera ─────────────────────────────────────────────────────────────────

  if (step === 'camera') {
    return (
      <View style={[styles.root, { backgroundColor: '#000' }]}>
        {hasPermission && device ? (
          <Camera style={StyleSheet.absoluteFill} isActive={appActive} device={device} outputs={[photoOutput]} onError={() => setProblem('The camera stopped. Close this and try again.')} />
        ) : (
          <View style={styles.centered}>
            <Feather name={hasPermission ? 'camera-off' : 'camera'} size={28} color="#fff" />
            <Text style={styles.centerLead}>
              {!hasPermission
                ? 'I need the camera to see your meal.'
                : 'No camera here. Meal photos need a phone.'}
            </Text>
            <Text style={styles.centerSub}>
              {!hasPermission
                ? permissionBlocked
                  ? 'Camera access is off for Overload. Open Settings to switch it on, then come back.'
                  : 'The photo goes to Drona to read the food. Nothing is saved to your gallery.'
                : 'You can still type what you ate in the food box.'}
            </Text>
            {!hasPermission && (
              <Pressable
                onPress={permissionBlocked ? () => void Linking.openSettings() : () => void askForCamera()}
                style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.85 }]}
              >
                <Text style={styles.primaryLabel}>{permissionBlocked ? 'Open Settings' : 'Allow camera'}</Text>
              </Pressable>
            )}
          </View>
        )}

        <View style={[styles.header, { paddingTop: insets.top + Spacing.sm }]}>
          <Pressable onPress={close} hitSlop={12} style={styles.closeBtn} accessibilityRole="button" accessibilityLabel="Close">
            <Feather name="x" size={20} color="#fff" />
          </Pressable>
          <Text style={styles.title}>{shots.length ? 'Second angle' : 'Snap your meal'}</Text>
          <View style={styles.closeBtn} />
        </View>

        {hasPermission && device && (
          <View style={[styles.cameraFoot, { paddingBottom: insets.bottom + Spacing.lg }]}>
            <Text style={styles.tip}>
              {shots.length
                ? 'From the side this time, so I can see how deep it is.'
                : 'From above, with the whole plate in frame. A fork or your hand beside it helps me judge size.'}
            </Text>
            {problem && <Text style={styles.problem}>{problem}</Text>}
            <Pressable
              onPress={() => void takePhoto()}
              disabled={busy}
              style={({ pressed }) => [styles.shutter, (pressed || busy) && { opacity: 0.7 }]}
              accessibilityRole="button"
              accessibilityLabel="Take the photo"
            >
              {busy ? <ActivityIndicator color="#000" /> : <View style={styles.shutterInner} />}
            </Pressable>
            {shots.length > 0 && (
              <Pressable onPress={() => setStep('review')} hitSlop={8}>
                <Text style={styles.link}>Skip the second angle</Text>
              </Pressable>
            )}
          </View>
        )}
      </View>
    );
  }

  // ── review ─────────────────────────────────────────────────────────────────

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: C.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[styles.header, { paddingTop: insets.top + Spacing.sm }]}>
        <Pressable onPress={close} hitSlop={12} style={styles.closeBtn} accessibilityRole="button" accessibilityLabel="Close">
          <Feather name="x" size={20} color={C.foreground} />
        </Pressable>
        <Text style={[styles.title, { color: C.foreground }]}>Your meal</Text>
        <View style={styles.closeBtn} />
      </View>

      <ScrollView contentContainerStyle={styles.reviewBody} keyboardShouldPersistTaps="handled">
        <View style={styles.thumbs}>
          {shots.map((s, i) => (
            <View key={s.uri} style={[styles.thumbWrap, { backgroundColor: C.card }]}>
              <Image source={{ uri: s.uri }} style={styles.thumb} resizeMode="cover" />
              <Pressable
                onPress={() => retake(i)}
                hitSlop={8}
                style={styles.thumbX}
                accessibilityRole="button"
                accessibilityLabel={`Remove photo ${i + 1}`}
              >
                <Feather name="x" size={12} color="#fff" />
              </Pressable>
            </View>
          ))}
          {shots.length < PHOTO_MAX_IMAGES && (
            <Pressable
              onPress={() => setStep('camera')}
              style={[styles.thumbWrap, styles.addAngle, { borderColor: C.border }]}
              accessibilityRole="button"
              accessibilityLabel="Add a second angle"
            >
              <Feather name="plus" size={16} color={C.textSecondary} />
              <Text style={[styles.addAngleText, { color: C.textSecondary }]}>Another angle</Text>
            </Pressable>
          )}
        </View>

        <Text style={[styles.noteLabel, { color: C.foreground }]}>Anything I can't see?</Text>
        <TextInput
          style={[styles.noteInput, { color: C.foreground, backgroundColor: C.inputBg, borderColor: C.borderSubtle }]}
          value={note}
          onChangeText={setNote}
          placeholder="Oil or ghee, what's inside, how much you ate"
          placeholderTextColor={C.textDim}
          multiline
          maxLength={500}
        />
        <Text style={[styles.noteHint, { color: C.textMuted }]}>
          A weight or a count beats my eye. "Cooked in 1 tbsp ghee" or "ate half" changes the numbers more than a better photo.
        </Text>
      </ScrollView>

      <View style={[styles.reviewFoot, { paddingBottom: insets.bottom + Spacing.lg, borderTopColor: C.borderSubtle }]}>
        <Pressable
          onPress={send}
          style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.85 }]}
          accessibilityRole="button"
          accessibilityLabel="Send to Drona"
        >
          <Text style={styles.primaryLabel}>Send to Drona</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    zIndex: 2,
  },
  closeBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  title: { color: '#fff', fontSize: FontSize.lg, fontWeight: FontWeight.semibold },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.md, paddingHorizontal: Spacing.xl },
  centerLead: { color: '#fff', fontSize: FontSize.lg, fontWeight: FontWeight.semibold, textAlign: 'center' },
  centerSub: { color: 'rgba(255,255,255,0.75)', fontSize: FontSize.base, textAlign: 'center', lineHeight: 20 },
  cameraFoot: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.lg,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  tip: { color: '#fff', fontSize: FontSize.base, textAlign: 'center', lineHeight: 20 },
  problem: { color: '#ffb4a8', fontSize: FontSize.sm, textAlign: 'center' },
  shutter: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 4,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterInner: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#fff' },
  link: { color: '#fff', fontSize: FontSize.sm, textDecorationLine: 'underline' },
  reviewBody: { paddingTop: 96, paddingHorizontal: Spacing.lg, paddingBottom: Spacing.xl, gap: Spacing.md },
  thumbs: { flexDirection: 'row', gap: Spacing.md },
  thumbWrap: { flex: 1, aspectRatio: 3 / 4, borderRadius: Radius.lg, overflow: 'hidden' },
  thumb: { width: '100%', height: '100%' },
  thumbX: {
    position: 'absolute',
    top: Spacing.sm,
    right: Spacing.sm,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addAngle: { borderWidth: 1, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', gap: Spacing.xs },
  addAngleText: { fontSize: FontSize.sm },
  noteLabel: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, marginTop: Spacing.sm },
  noteInput: {
    minHeight: 72,
    borderRadius: Radius.md,
    borderWidth: 1,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    fontSize: FontSize.base,
    textAlignVertical: 'top',
  },
  noteHint: { fontSize: FontSize.sm, lineHeight: 18 },
  reviewFoot: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.md, borderTopWidth: StyleSheet.hairlineWidth },
  primaryBtn: {
    backgroundColor: Colors.primary,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.xl,
    alignItems: 'center',
    alignSelf: 'stretch',
  },
  primaryLabel: { color: Colors.primaryFg, fontSize: FontSize.base, fontWeight: FontWeight.semibold },
});
