/**
 * The mic for the food box and Drona chat: tap to talk, tap to stop, and
 * what was said is added to the box for the user to check and send.
 *
 * Self-contained, so each screen mounts it with one line:
 *   <MicButton purpose="food" onText={(t) => setText((prev) => insertTranscript(prev, t))} />
 * The screen passes a functional update, so text typed while the clip
 * uploads is kept and the transcript goes after it (lib/voiceInput.ts).
 *
 * Shown only when all of these hold (otherwise it renders nothing):
 *   - the binary declares the microphone (VOICE_FROM_VERSION). On an older
 *     binary iOS ends the app the moment it asks for the mic.
 *   - expo-audio's native module is in this build
 *   - signed in, with in-app AI: free, trial or Pro, not Connect. The same
 *     gate as the AI food log; the server checks it again.
 *
 * Permission: the first tap explains in our words, then the phone asks. A
 * "never" offers Settings. A "no" leaves typing as it was.
 *
 * States: idle (mic), recording (stop square, a ring that swells with the
 * voice level, a buzz at start), sending (spinner). It stops itself at 60 s.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Platform, Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import * as Application from 'expo-application';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { Feather } from '@expo/vector-icons';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useTheme } from '@/hooks/useTheme';
import { useCoachAccess } from '@/hooks/useCoachAccess';
import { useClerkUser } from '@/hooks/useClerkUser';
import { useToast } from '@/components/ui/Toast';
import { haptics } from '@/lib/haptics';
import {
  levelFromMetering,
  MAX_CLIP_MS,
  MIC_COPY,
  micStep,
  MIN_CLIP_MS,
  VOICE_RECORDING,
  voiceSupported,
} from '@/lib/voiceInput';
import { deleteClip, transcribeClip } from '@/lib/voiceTranscribe';

type ExpoAudio = typeof import('expo-audio');

let audioModule: ExpoAudio | null | undefined;
function loadAudio(): ExpoAudio | null {
  if (audioModule !== undefined) return audioModule;
  // Ask the native side first (null, not a throw, on a build without it):
  // Metro's dev runtime redboxes a failed module eval even inside try/catch.
  if (!requireOptionalNativeModule('ExpoAudio')) return (audioModule = null);
  try {
    audioModule = require('expo-audio') as ExpoAudio;
  } catch {
    audioModule = null;
  }
  return audioModule;
}

const BINARY_HAS_MIC = voiceSupported({
  nativeVersion: Application.nativeApplicationVersion,
  platform: Platform.OS,
  isDev: __DEV__,
  devFlag: process.env.EXPO_PUBLIC_VOICE_DEV === '1',
});

interface Props {
  purpose: 'food' | 'chat';
  /** Called with what was heard. Add it to the box; never send it. */
  onText: (text: string) => void;
  disabled?: boolean;
  /** Tap target and ring size. 28 in the food box, 36 in chat. */
  size?: number;
  iconColor?: string;
  style?: ViewStyle;
}

export function MicButton(props: Props) {
  const { isSignedIn } = useClerkUser();
  const { access } = useCoachAccess();
  const hasAi = access.state === 'paid' || access.state === 'trialing' || access.state === 'free';
  if (!BINARY_HAS_MIC || !isSignedIn || !hasAi || access.aiBlocked) return null;
  const audio = loadAudio();
  if (!audio) return null;
  return <MicButtonLive {...props} audio={audio} />;
}

type Phase = 'idle' | 'recording' | 'sending';

function MicButtonLive({ purpose, onText, disabled, size = 28, iconColor, style, audio }: Props & { audio: ExpoAudio }) {
  const { C } = useTheme();
  const toast = useToast();
  const recorder = audio.useAudioRecorder(VOICE_RECORDING as unknown as Parameters<ExpoAudio['useAudioRecorder']>[0]);
  const status = audio.useAudioRecorderState(recorder, 100);
  const [phase, setPhase] = useState<Phase>('idle');
  const phaseRef = useRef<Phase>('idle');
  const mounted = useRef(true);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const setP = (p: Phase) => {
    phaseRef.current = p;
    if (mounted.current) setPhase(p);
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Leaving the screen mid-clip: stop, drop the file, give the audio
      // session back. Nothing is uploaded.
      if (phaseRef.current === 'recording') {
        void recorder.stop().then(() => deleteClip(recorder.uri), () => {});
        void audio.setAudioModeAsync({ allowsRecording: false }).catch(() => {});
      }
    };
  }, []);

  const level = useSharedValue(0);
  useEffect(() => {
    level.value = withTiming(phase === 'recording' ? levelFromMetering(status.metering) : 0, { duration: 120 });
  }, [phase, status.metering]);
  const ringStyle = useAnimatedStyle(() => ({
    opacity: level.value > 0 ? 0.25 + level.value * 0.35 : 0,
    transform: [{ scale: 1 + level.value * 0.55 }],
  }));

  const begin = useCallback(async () => {
    try {
      await audio.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      haptics.tap();
      setP('recording');
    } catch {
      void audio.setAudioModeAsync({ allowsRecording: false }).catch(() => {});
      setP('idle');
      toast.show({ type: 'error', text: "The mic didn't start. Try again, or type it." });
    }
  }, [audio, recorder]);

  const finish = useCallback(async () => {
    if (phaseRef.current !== 'recording') return;
    const heldMs = recorder.getStatus().durationMillis ?? 0;
    setP('sending');
    haptics.tick();
    try {
      await recorder.stop();
    } catch {
      /* the file below is what counts */
    }
    void audio.setAudioModeAsync({ allowsRecording: false }).catch(() => {});
    const uri = recorder.uri;
    if (!uri || heldMs < MIN_CLIP_MS) {
      deleteClip(uri);
      setP('idle');
      return;
    }
    const out = await transcribeClip(uri, purpose);
    if (!mounted.current) return;
    setP('idle');
    if (out.ok) onTextRef.current(out.text);
    else toast.show({ type: out.kind === 'nothing_heard' ? 'info' : 'error', text: out.message, durationMs: 4000 });
  }, [audio, recorder, purpose]);

  // A minute is the cap: stop and write out what is there.
  useEffect(() => {
    if (phase === 'recording' && (status.durationMillis ?? 0) >= MAX_CLIP_MS) void finish();
  }, [phase, status.durationMillis, finish]);

  const onPress = useCallback(async () => {
    if (phaseRef.current === 'recording') return void finish();
    if (phaseRef.current === 'sending') return;
    let perm: Awaited<ReturnType<ExpoAudio['getRecordingPermissionsAsync']>> | null = null;
    try {
      perm = await audio.getRecordingPermissionsAsync();
    } catch {
      perm = null;
    }
    const step = micStep(perm);
    if (step === 'record') return void begin();
    if (step === 'unavailable') {
      toast.show({ type: 'error', text: "The mic isn't available on this phone. Typing works." });
      return;
    }
    if (step === 'settings') {
      Alert.alert(MIC_COPY.settingsTitle, MIC_COPY.settingsBody, [
        { text: MIC_COPY.settingsLater, style: 'cancel' },
        { text: MIC_COPY.settingsOpen, onPress: () => void Linking.openSettings() },
      ]);
      return;
    }
    Alert.alert(MIC_COPY.explainTitle, MIC_COPY.explainBody, [
      { text: MIC_COPY.explainLater, style: 'cancel' },
      {
        text: MIC_COPY.explainAllow,
        onPress: async () => {
          try {
            const asked = await audio.requestRecordingPermissionsAsync();
            if (asked.granted) void begin();
            else toast.show({ type: 'info', text: MIC_COPY.deniedToast, durationMs: 2500 });
          } catch {
            toast.show({ type: 'error', text: "The mic didn't start. Try again, or type it." });
          }
        },
      },
    ]);
  }, [audio, begin, finish]);

  const recording = phase === 'recording';
  const tint = iconColor ?? C.textSecondary;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled && !recording}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={recording ? 'Stop and write it out' : phase === 'sending' ? 'Writing out what you said' : 'Talk instead of typing'}
      accessibilityState={{ busy: phase === 'sending', disabled: !!disabled && !recording }}
      style={[{ width: size, height: size, opacity: disabled && !recording ? 0.4 : 1 }, s.wrap, style]}
    >
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { borderRadius: size / 2, backgroundColor: C.dangerText }, ringStyle]}
      />
      {phase === 'sending' ? (
        <ActivityIndicator size="small" color={tint} />
      ) : recording ? (
        <View style={[s.stop, { backgroundColor: C.dangerText }]} />
      ) : (
        <Feather name="mic" size={16} color={tint} />
      )}
    </Pressable>
  );
}

const s = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
  stop: { width: 11, height: 11, borderRadius: 2.5 },
});
