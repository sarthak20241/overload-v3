/**
 * "Read Drona's replies aloud": a header button that turns it on or off,
 * and while on, speaks each reply once it has finished arriving.
 *
 * On the phone, through expo-speech (the system voice): free, nothing leaves
 * the phone, works offline. The text is the reply without its tables, charts
 * or markdown (lib/voiceSpeech.ts). A new question, turning it off, or
 * leaving the chat stops the voice. The choice is kept on this phone.
 *
 * One line to mount: <ReadAloudToggle messages={messages} loading={loading} />.
 * Renders nothing on a build without expo-speech's native module (an older
 * binary that got this code as an update).
 */
import { useEffect, useRef, useState } from 'react';
import { Pressable, type ViewStyle } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Feather } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { haptics } from '@/lib/haptics';
import { speakableText } from '@/lib/voiceSpeech';

type ExpoSpeech = typeof import('expo-speech');

let speechModule: ExpoSpeech | null | undefined;
function loadSpeech(): ExpoSpeech | null {
  if (speechModule !== undefined) return speechModule;
  if (!requireOptionalNativeModule('ExpoSpeech')) return (speechModule = null);
  try {
    speechModule = require('expo-speech') as ExpoSpeech;
  } catch {
    speechModule = null;
  }
  return speechModule;
}

const PREF_KEY = 'drona_read_aloud_v1';

interface Msg {
  id: string;
  role: string;
  content: string;
}

export function ReadAloudToggle({ messages, loading, style }: { messages: Msg[]; loading: boolean; style?: ViewStyle }) {
  const speech = loadSpeech();
  if (!speech) return null;
  return <ReadAloudLive speech={speech} messages={messages} loading={loading} style={style} />;
}

function ReadAloudLive({ speech, messages, loading, style }: { speech: ExpoSpeech; messages: Msg[]; loading: boolean; style?: ViewStyle }) {
  const { C } = useTheme();
  const [on, setOn] = useState(false);
  const spokenId = useRef<string | null>(null);
  const wasLoading = useRef(loading);

  useEffect(() => {
    AsyncStorage.getItem(PREF_KEY).then((v) => setOn(v === '1'), () => {});
    return () => void speech.stop().catch(() => {});
  }, []);

  useEffect(() => {
    const finished = wasLoading.current && !loading;
    wasLoading.current = loading;
    // A new question: stop reading the old answer.
    if (loading) {
      void speech.stop().catch(() => {});
      return;
    }
    if (!finished || !on) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant' || spokenId.current === last.id) return;
    const text = speakableText(last.content);
    if (!text) return;
    spokenId.current = last.id;
    speech.speak(text);
  }, [loading, on, messages]);

  const toggle = () => {
    haptics.tap();
    const next = !on;
    setOn(next);
    void AsyncStorage.setItem(PREF_KEY, next ? '1' : '0').catch(() => {});
    if (!next) void speech.stop().catch(() => {});
    // Turning it on does not read the reply already on screen: it reads the
    // next one. Marking the current one keeps a re-render from reading it.
    const last = messages[messages.length - 1];
    if (next && last) spokenId.current = last.id;
  };

  return (
    <Pressable
      onPress={toggle}
      hitSlop={8}
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel="Read Drona's replies aloud"
      style={[{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: C.muted }, style]}
    >
      <Feather name={on ? 'volume-2' : 'volume-x'} size={16} color={on ? C.foreground : C.textMuted} />
    </Pressable>
  );
}
