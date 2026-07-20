/**
 * AI Coach Modal — full-screen bottom sheet with 3 options:
 * 1. Chat with AI Coach
 * 2. Generate Workout Plan
 * 3. Generate a Workout
 * Matches Figma design exactly.
 */
import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, BackHandler, Pressable,
  TextInput, ScrollView, FlatList, Keyboard, Platform,
  ActivityIndicator, Linking, useWindowDimensions,
} from 'react-native';
import Animated, {
  SlideInDown, SlideOutDown, FadeIn, FadeInDown, Easing,
} from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Portal } from '@/components/ui/Portal';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { useClerkUser, hasClerkKey } from '@/hooks/useClerkUser';
import { isSupabaseConfigured, useSupabaseClient } from '@/lib/supabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import { addGuestRoutine } from '@/lib/guestStore';
import { useToast } from '@/components/ui/Toast';
import { useCoachAccess } from '@/hooks/useCoachAccess';
import { CoachAccessGate } from './CoachAccessGate';
import { Paywall } from './Paywall';
import type { WorkoutCoachContext } from '@/lib/workoutCoach';
import {
  workoutCoachOpener,
  workoutCoachStarter,
  workoutCoachSuggestions,
  workoutCoachReviewRequest,
} from '@/lib/workoutCoach';
import { useCoachConversation } from '@/hooks/useCoachConversation';
import { ensureActiveConversationId } from '@/lib/coachConversations';
import type { CoachChatMessage, CoachCitation } from '@/lib/coachConversations';

// ─── Types ───────────────────────────────────────────────────────────────────
type Screen = 'menu' | 'chat' | 'plan' | 'workout';

// Chat message + citation shapes live in lib/coachConversations.ts so the
// persistence layer and the UI share one definition. Aliased here to keep the
// existing call sites (Citation, ChatMessage) unchanged. CoachChatMessage
// carries the transient `thinkingPhase` (shown instead of a bare spinner while
// the assistant placeholder waits on first token); it is stripped before any
// message is persisted.
type Citation = CoachCitation;
type ChatMessage = CoachChatMessage;

// Sliding window: cap how many recent turns we resend to the edge function each
// turn. The whole transcript is persisted locally, but a very long thread would
// otherwise grow per-turn input tokens without bound (the messages array isn't
// under a prompt-cache breakpoint). Durable facts from early turns survive in
// coach memory, so trimming old turns costs little. A no-op for typical chats.
const MAX_SENT_MESSAGES = 24;

interface CoachReply {
  text: string;
  citations: Citation[];
}

interface GeneratedExercise {
  name: string;
  sets: number;
  reps: string;
  rest: string;
  // Phase 2.5: coaching cue. Examples: "RIR 2", "Go heavy, control eccentric",
  // "Hams-focused, push hips back", "Last set to failure".
  note?: string;
}

interface GeneratedWorkout {
  name: string;
  exercises: GeneratedExercise[];
  // Phase 2.5: explanation shown above the exercise list — why this workout
  // fits THIS user. Set by the coach's generate_workout tool. Optional so
  // older callers (mocks) still type-check.
  rationale?: string;
  focus?: string;
  estimated_duration_min?: number;
}

interface GeneratedPlan {
  name: string;
  rationale: string;
  split_type?: string;
  days_per_week?: number;
  workouts: Array<GeneratedWorkout & { note?: string }>;
}

// Normalize the structured input from generate_workout/generate_plan into
// our GeneratedWorkout shape (the existing one used rest as "90s" strings;
// the tool schema uses rest_seconds as int — we convert).
function structuredToWorkout(input: Record<string, unknown>): GeneratedWorkout {
  const exercises = Array.isArray(input.exercises)
    ? (input.exercises as Array<Record<string, unknown>>).map((e) => ({
        name: String(e.name ?? ''),
        sets: Number(e.sets ?? 3),
        reps: String(e.reps ?? '8-12'),
        rest: typeof e.rest_seconds === 'number' ? `${e.rest_seconds}s` : '90s',
        note: typeof e.note === 'string' && e.note.length > 0 ? e.note : undefined,
      }))
    : [];
  return {
    name: String(input.name ?? 'New Workout'),
    rationale: typeof input.rationale === 'string' ? input.rationale : undefined,
    focus: typeof input.focus === 'string' ? input.focus : undefined,
    estimated_duration_min: typeof input.estimated_duration_min === 'number'
      ? input.estimated_duration_min
      : undefined,
    exercises,
  };
}

function structuredToPlan(input: Record<string, unknown>): GeneratedPlan {
  const workouts = Array.isArray(input.workouts)
    ? (input.workouts as Array<Record<string, unknown>>).map((w) => ({
        ...structuredToWorkout(w),
        note: typeof w.note === 'string' && w.note.length > 0 ? w.note : undefined,
      }))
    : [];
  return {
    name: String(input.name ?? 'New Plan'),
    rationale: String(input.rationale ?? ''),
    split_type: typeof input.split_type === 'string' ? input.split_type : undefined,
    days_per_week: typeof input.days_per_week === 'number' ? input.days_per_week : undefined,
    workouts,
  };
}

// ─── Sparkle Icon ────────────────────────────────────────────────────────────
function SparkleIcon({ size = 20, color = '#4d7a00' }: { size?: number; color?: string }) {
  return <Feather name="zap" size={size} color={color} />;
}

// ─── Thinking Indicator (Phase 2.6) ──────────────────────────────────────────
// Shown inside the assistant bubble while waiting for the first streamed
// token. Three dots cycle (./../...) at ~3 Hz to convey "the model is
// working" without the visual heaviness of a spinner. The phase text updates
// from server `status` events as the request moves through stages.
function ThinkingIndicator({ phase }: { phase: string }) {
  const { C } = useTheme();
  const [dots, setDots] = useState('');
  useEffect(() => {
    const states = ['', '.', '..', '...'];
    let i = 0;
    const id = setInterval(() => {
      i = (i + 1) % states.length;
      setDots(states[i]);
    }, 350);
    return () => clearInterval(id);
  }, []);
  return (
    <View style={s.thinkingRow}>
      <Text style={[s.thinkingText, { color: C.textMuted }]}>{phase}{dots}</Text>
    </View>
  );
}

// ─── Citation List (Phase 2.3) ───────────────────────────────────────────────
// ─── MessageContent (Phase 2.6+) ─────────────────────────────────────────────
// Renders the assistant's markdown-flavored output: paragraphs, bullet lists,
// **bold** runs, and inline [N] citation pills that tap to open the source.
// Parses partial markdown gracefully (an unclosed `**` mid-stream renders as
// plain text until the closing pair arrives in the next delta).
function MessageContent({
  content: rawContent,
  citations,
  textColor,
}: { content: string; citations?: Citation[]; textColor: string }) {
  const { C } = useTheme();
  // No em dashes in the coach's voice (user preference): the model still emits
  // them despite the system-prompt rule, so normalize at the render boundary.
  // Only collapse horizontal space around the em dash ([ \t], NOT \s) so that
  // newlines survive and paragraph / bullet-list block boundaries are kept.
  // Em dash -> ", "; en dash -> "-" so rep ranges like "8–10" stay "8-10".
  // Finally drop a comma left dangling by a trailing em dash.
  const content = rawContent
    .replace(/[ \t]*—[ \t]*/g, ', ')
    .replace(/–/g, '-')
    .replace(/,\s*$/, '');
  // Token-stream inline parser: handles **bold** and [N] citation markers.
  const renderInline = (text: string): React.ReactNode[] => {
    const out: React.ReactNode[] = [];
    let i = 0;
    let key = 0;
    while (i < text.length) {
      const rest = text.slice(i);
      const boldMatch = /^\*\*([^*]+?)\*\*/.exec(rest);
      if (boldMatch) {
        out.push(
          <Text key={key++} style={{ fontWeight: FontWeight.bold, color: textColor }}>
            {boldMatch[1]}
          </Text>,
        );
        i += boldMatch[0].length;
        continue;
      }
      const citeMatch = /^\[(\d+)\]/.exec(rest);
      if (citeMatch) {
        const n = parseInt(citeMatch[1], 10);
        const cite = citations?.find((c) => c.n === n);
        out.push(
          <Text
            key={key++}
            onPress={cite?.url ? () => Linking.openURL(cite.url!).catch(() => {}) : undefined}
            style={{
              color: C.accentText,
              fontWeight: FontWeight.semibold,
              fontSize: 11,
              backgroundColor: C.muted,
              paddingHorizontal: 5,
              borderRadius: 4,
            }}
          >
            {citeMatch[1]}
          </Text>,
        );
        i += citeMatch[0].length;
        continue;
      }
      // Plain run up to next special
      const nextSpecial = rest.search(/\*\*|\[\d+\]/);
      const chunk = nextSpecial === -1 ? rest : rest.slice(0, nextSpecial);
      if (chunk) out.push(<Text key={key++} style={{ color: textColor }}>{chunk}</Text>);
      i += chunk.length || 1;
    }
    return out;
  };

  // Split into blocks on blank lines. Each block is either a bullet list or
  // a paragraph.
  const blocks = content.split(/\n\n+/);
  return (
    <View>
      {blocks.map((block, bi) => {
        const lines = block.split('\n').filter((l) => l.length > 0);
        const allBullets = lines.length > 0 && lines.every((l) => /^[\-\*•]\s+/.test(l));
        if (allBullets) {
          return (
            <View key={bi} style={s.mdList}>
              {lines.map((line, li) => (
                <View key={li} style={s.mdBulletRow}>
                  <Text style={[s.mdBulletDot, { color: C.accentText }]}>•</Text>
                  <Text style={[s.chatText, { color: textColor, flex: 1 }]}>
                    {renderInline(line.replace(/^[\-\*•]\s+/, ''))}
                  </Text>
                </View>
              ))}
            </View>
          );
        }
        // Plain paragraph (preserve single-newline soft breaks)
        return (
          <Text key={bi} style={[s.chatText, { color: textColor, marginBottom: bi < blocks.length - 1 ? 8 : 0 }]}>
            {renderInline(block)}
          </Text>
        );
      })}
    </View>
  );
}

// Renders the structured citations[] array returned by the edge function under
// an assistant message bubble. Tapping a pill opens the source URL (usually a
// PubMed link) in the system browser.
function CitationList({ citations }: { citations: Citation[] }) {
  const { C } = useTheme();
  return (
    <View style={s.citationList}>
      <View style={s.citationHeader}>
        <Feather name="book-open" size={11} color={C.textMuted} />
        <Text style={[s.citationHeaderText, { color: C.textMuted }]}>
          Sources
        </Text>
      </View>
      {citations.map((c) => {
        const surname = c.authors[0]?.split(' ')[0] ?? 'Unknown';
        const meta = c.authors.length > 1
          ? `${surname} et al.${c.year ? ` · ${c.year}` : ''}`
          : `${surname}${c.year ? ` · ${c.year}` : ''}`;
        return (
          <Pressable
            key={c.id}
            onPress={() => { if (c.url) Linking.openURL(c.url).catch(() => {}); }}
            style={({ pressed }) => [
              s.citationPill,
              { backgroundColor: C.muted, opacity: pressed ? 0.55 : 1 },
            ]}
          >
            <Text style={[s.citationN, { color: C.accentText }]}>[{c.n}]</Text>
            <View style={{ flex: 1 }}>
              <Text style={[s.citationTitle, { color: C.foreground }]} numberOfLines={2}>
                {c.title}
              </Text>
              <Text style={[s.citationMeta, { color: C.textMuted }]}>{meta}</Text>
            </View>
            {c.url && <Feather name="external-link" size={11} color={C.textMuted} />}
          </Pressable>
        );
      })}
    </View>
  );
}

// ─── Focus Area Quick Picks ──────────────────────────────────────────────────
const FOCUS_PICKS = ['Push Day', 'Pull Day', 'Leg Day', 'Full Body', 'Upper Body', 'Core'];

const DURATION_OPTIONS = ['30 min', '45 min', '60 min', '75 min', '90 min'];
const EQUIPMENT_OPTIONS = ['Full Gym', 'Dumbbells Only', 'Bodyweight', 'Home Gym', 'Resistance Bands'];
const DAYS_OPTIONS = ['2 days', '3 days', '4 days', '5 days', '6 days'];
const SESSION_OPTIONS = ['30-45 min', '45-60 min', '60-75 min', '75-90 min'];

/**
 * Sentinel returned by callAICoach when the live AI endpoint is unreachable
 * AND we're in a configured (non-guest) environment. Callers must surface a
 * user-visible "AI Coach unavailable" state instead of silently displaying
 * canned mock text as if it were a real model response.
 */
export class AICoachUnavailableError extends Error {
  constructor(message = 'Coach Drona is currently unavailable. Try again in a moment.') {
    super(message);
    this.name = 'AICoachUnavailableError';
  }
}

// ─── AI API Call ─────────────────────────────────────────────────────────────
// Takes the Clerk-aware Supabase client as a parameter rather than referencing
// a module-level import. Top-level functions can't call hooks, and only the
// useSupabaseClient() output carries the Clerk JWT in its custom fetch.
async function callAICoach(
  messages: { role: string; content: string }[],
  supabase: SupabaseClient,
): Promise<CoachReply> {
  // Configured environments must hit the real edge function. Guest/demo mode
  // (no Supabase) falls back to the canned mock so the UI still demonstrates the flow.
  if (isSupabaseConfigured) {
    try {
      const { data, error } = await supabase.functions.invoke('ai-coach', {
        body: { messages },
      });
      if (error) {
        // supabase-js wraps non-2xx as FunctionsHttpError with the body buried
        // in error.context. Surface it so server-side reasons are visible in
        // the chat instead of the generic "non-2xx status code".
        let detail = error?.message || 'Edge Function failed';
        try {
          const ctx = (error as any)?.context;
          if (ctx && typeof ctx.json === 'function') {
            const body = await ctx.json();
            detail = body?.error
              ? `${body.error}${body.debug ? ` (${body.debug})` : ''}`
              : JSON.stringify(body);
          }
        } catch { /* fall through */ }
        throw new AICoachUnavailableError(`Coach Drona error: ${detail}`);
      }
      if (data?.response) {
        return {
          text: data.response as string,
          citations: Array.isArray(data.citations) ? (data.citations as Citation[]) : [],
        };
      }
      throw new AICoachUnavailableError();
    } catch (err: any) {
      if (err instanceof AICoachUnavailableError) throw err;
      throw new AICoachUnavailableError(
        err?.message ? `Coach Drona error: ${err.message}` : undefined
      );
    }
  }
  // Guest/demo mode only: canned response, no citations
  return { text: getMockResponse(messages[messages.length - 1]?.content || ''), citations: [] };
}

// ─── Streaming AI API call (Phase 2.6) ───────────────────────────────────────
// Uses `expo/fetch` — Expo SDK 53+ ships a native fetch backed by a true
// streaming network module, so `response.body.getReader()` yields chunks as
// bytes arrive. The global `fetch` (whatwg polyfill) buffers the full body
// before resolving, so we'd lose streaming entirely if we used it.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const expoFetch = require('expo/fetch').fetch as typeof globalThis.fetch;
interface StreamingCallbacks {
  onDelta: (text: string) => void;
  onStatus?: (phase: string, payload: Record<string, unknown>) => void;
  // Phase 2.5: structured tool output (generate_workout / generate_plan).
  onStructured?: (payload: { name: string; input: Record<string, unknown> }) => void;
  onDone: (payload: {
    citations: Citation[];
    usage?: unknown;
    tool_calls?: string[];
    structured?: { name: string; input: Record<string, unknown> } | null;
  }) => void;
  onError: (err: string) => void;
  // Fan-out plan generation (2026-07-19). The backend now builds a plan as a
  // skeleton call followed by parallel per-day fills, so the structure lands
  // at ~5s and each day's prescriptions follow. Both are optional: a client
  // that ignores them still gets the identical `structured` payload at the
  // end, which is why this shipped without touching the save path.
  onPlanSkeleton?: (s: {
    name: string;
    split_type?: string;
    days_per_week?: number;
    days: { name: string; note?: string; exercises: string[] }[];
  }) => void;
  onPlanDay?: (index: number, workout: Record<string, unknown>) => void;
}

interface StreamingOptions {
  // When set, forces tool_choice on that tool — used for Generate Workout /
  // Generate Plan flows so output is guaranteed structured.
  forceTool?: 'generate_workout' | 'generate_plan';
  // Conversational refine / discuss sessions. The backend exposes both
  // the read toolkit and the matching terminal tool, but leaves
  // tool_choice auto so the model can probe priorities first and only
  // emit the structured output once the user has confirmed. 'refine_*'
  // iterates on an existing workout/plan; 'discuss_*' designs a new one
  // from scratch (no recap assumption — different system-prompt branch).
  // (Caller still listens via onStructured for the final emission — same
  // as the forceTool path.)
  mode?: 'refine_workout' | 'refine_plan' | 'discuss_workout' | 'discuss_plan';
  // Phase 1 history: when set, the edge function mirrors this turn into the
  // server-side coach_conversations / coach_conversation_messages rows under
  // this conversation id. `clientMsgId` (the user message's id) keys the user +
  // assistant rows for idempotent replay. Omitted for the ephemeral in-workout
  // chat, which is never persisted.
  conversationId?: string;
  clientMsgId?: string;
}

function callAICoachStreaming(
  messages: { role: string; content: string }[],
  token: string,
  callbacks: StreamingCallbacks,
  options: StreamingOptions = {},
): { abort: () => void } {
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    callbacks.onError('Supabase not configured');
    return { abort: () => {} };
  }

  const controller = new AbortController();
  let buffer = '';

  const processChunk = (text: string) => {
    buffer += text;
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';
    for (const evtChunk of events) {
      let event = 'message';
      let data = '';
      for (const line of evtChunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      try {
        const parsed = JSON.parse(data);
        if (event === 'delta' && typeof parsed.text === 'string') {
          callbacks.onDelta(parsed.text);
        } else if (event === 'status') {
          callbacks.onStatus?.(parsed.phase ?? 'unknown', parsed);
        } else if (event === 'structured') {
          // Phase 2.5: generate_workout / generate_plan tool fired. Live
          // delivery — UI renders the workout card as soon as this arrives.
          if (parsed.name && parsed.input) {
            callbacks.onStructured?.({ name: parsed.name, input: parsed.input });
          }
        } else if (event === 'plan_skeleton') {
          // Fan-out: full plan structure, every exercise named, no
          // prescriptions yet. Arrives at roughly a third of total latency.
          if (Array.isArray(parsed.days)) callbacks.onPlanSkeleton?.(parsed);
        } else if (event === 'plan_day') {
          if (typeof parsed.index === 'number' && parsed.workout) {
            callbacks.onPlanDay?.(parsed.index, parsed.workout);
          }
        } else if (event === 'done') {
          callbacks.onDone({
            citations: Array.isArray(parsed.citations) ? (parsed.citations as Citation[]) : [],
            usage: parsed.usage,
            tool_calls: parsed.tool_calls,
            structured: parsed.structured ?? null,
          });
        } else if (event === 'error') {
          callbacks.onError(parsed.error ?? 'Unknown error');
        }
      } catch { /* malformed event — skip */ }
    }
  };

  (async () => {
    try {
      const response = await expoFetch(`${supabaseUrl}/functions/v1/ai-coach`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'apikey': anonKey,
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify({
          messages,
          stream: true,
          ...(options.forceTool ? { force_tool: options.forceTool } : {}),
          ...(options.mode ? { mode: options.mode } : {}),
          ...(options.conversationId ? { conversation_id: options.conversationId } : {}),
          ...(options.clientMsgId ? { client_msg_id: options.clientMsgId } : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        callbacks.onError(`HTTP ${response.status}: ${body.slice(0, 200)}`);
        return;
      }

      if (response.body && typeof (response.body as any).getReader === 'function') {
        const reader = (response.body as any).getReader() as {
          read: () => Promise<{ done: boolean; value?: Uint8Array }>;
        };
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) processChunk(decoder.decode(value, { stream: true }));
        }
        // Flush any trailing event
        if (buffer.length > 0) processChunk('\n\n');
      } else {
        // Fallback: no streaming body — read the whole response and parse
        const text = await response.text();
        processChunk(text);
        if (buffer.length > 0) processChunk('\n\n');
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      callbacks.onError(`Network error: ${String(e?.message ?? e)}`);
    }
  })();

  return { abort: () => controller.abort() };
}

// ─── Typewriter (Phase 2.6) ──────────────────────────────────────────────────
// Smooths out chunky SSE arrivals into a steady typewriter animation. The
// network delivers in bursts of 30-100 chars every 50-200ms; this drains a
// "received but not displayed" buffer at ~60fps and adapts its speed based on
// buffer pressure so the user always sees smooth typing — fast when the
// server is ahead, polite-typing-speed when in sync, full drain when finished.
type SetMessagesFn = React.Dispatch<React.SetStateAction<ChatMessage[]>>;

function createTypewriter(
  messageId: string,
  setMessages: SetMessagesFn,
  scrollRef: React.RefObject<ScrollView | null>,
) {
  let buffer = '';        // received-but-not-displayed
  let displayed = '';
  let interval: ReturnType<typeof setInterval> | null = null;
  let finished = false;
  let onComplete: (() => void) | null = null;

  // Tick every 35ms (~28fps). Char count per tick is adaptive based on buffer
  // depth so the typewriter catches up when the server is ahead.
  // Base rate ~30 cps = comfortable reading; previous 60+ cps felt rushed.
  const TICK_MS = 35;
  const tick = () => {
    if (buffer.length === 0) {
      if (finished) {
        stop();
        onComplete?.();
        onComplete = null;
      }
      return;
    }
    // Adaptive rate (~28 ticks/sec):
    //   buffer < 60:   1 char  (~28 cps, normal reading speed)
    //   60-200:        2 chars (~57 cps, mild catch-up)
    //   200-500:       4 chars (~114 cps)
    //   >500:          8 chars (~228 cps, drain hard — server way ahead)
    //   finished:      at least 3 chars so user isn't kept waiting
    let charsThisTick = 1;
    if (buffer.length > 500) charsThisTick = 8;
    else if (buffer.length > 200) charsThisTick = 4;
    else if (buffer.length > 60) charsThisTick = 2;
    if (finished && charsThisTick < 3) charsThisTick = 3;

    const next = buffer.slice(0, charsThisTick);
    buffer = buffer.slice(charsThisTick);
    displayed += next;
    setMessages(prev => prev.map(m =>
      m.id === messageId ? { ...m, content: displayed } : m
    ));
    // Auto-scroll while typing — animated:false keeps it cheap.
    scrollRef.current?.scrollToEnd({ animated: false });
  };

  const start = () => {
    if (interval) return;
    interval = setInterval(tick, TICK_MS);
  };
  const stop = () => {
    if (interval) { clearInterval(interval); interval = null; }
  };

  return {
    append(chunk: string) {
      if (!chunk) return;
      buffer += chunk;
      start();
    },
    // Mark the stream complete. The typewriter keeps animating until the
    // buffer drains, THEN invokes onComplete (so citations land after the
    // text has finished typing — feels weird if they appear early).
    finish(cb: () => void) {
      finished = true;
      onComplete = cb;
      // If buffer is already empty, drain has effectively completed.
      if (buffer.length === 0) {
        stop();
        cb();
        onComplete = null;
      } else {
        // Nudge the loop in case it wasn't running yet
        start();
      }
    },
    // Hard-set the message content (used on error). Cancels animation.
    fail(text: string) {
      stop();
      buffer = '';
      displayed = text;
      finished = true;
      setMessages(prev => prev.map(m =>
        m.id === messageId ? { ...m, content: displayed } : m
      ));
    },
  };
}

function getMockResponse(userMsg: string): string {
  const lower = userMsg.toLowerCase();
  if (lower.includes('workout') || lower.includes('create')) {
    return "Here's a workout I'd suggest based on your goals:\n\n**Push Day**\n- Bench Press: 4x8-10\n- Overhead Press: 3x8-12\n- Incline Dumbbell Press: 3x10-12\n- Lateral Raises: 3x12-15\n- Tricep Pushdowns: 3x12-15\n\nThis targets chest, shoulders, and triceps with progressive overload in mind. Want me to save this as a routine?";
  }
  if (lower.includes('plan') || lower.includes('program')) {
    return "I'd recommend a 4-day Push/Pull/Legs split:\n\n**Day 1 - Push**: Bench, OHP, Incline DB, Lateral Raises, Tricep Pushdowns\n**Day 2 - Pull**: Deadlift, Rows, Pull-ups, Face Pulls, Curls\n**Day 3 - Rest**\n**Day 4 - Legs**: Squats, RDL, Leg Press, Leg Curls, Calf Raises\n**Day 5 - Upper**: Bench, Rows, OHP, Pull-ups, Arms\n\nWant me to create these routines for you?";
  }
  if (lower.includes('progress') || lower.includes('pr')) {
    return "Based on your recent workouts, you've been making solid progress! Your bench press volume has increased 12% over the last 4 weeks. Keep pushing for progressive overload by adding small weight increments each session.";
  }
  if (lower.includes('nutrition') || lower.includes('diet') || lower.includes('eat')) {
    return "For muscle building, aim for 1.6-2.2g protein per kg bodyweight daily. Focus on whole foods, stay hydrated, and time your meals around your training. Pre-workout: carbs + protein. Post-workout: protein + carbs within 2 hours.";
  }
  return "I can help with programming, nutrition, recovery, and progression. What do you want to work on?";
}

// ─── Dropdown Picker ─────────────────────────────────────────────────────────
function DropdownPicker({
  options,
  value,
  onSelect,
}: {
  options: string[];
  value: string;
  onSelect: (v: string) => void;
}) {
  const { C } = useTheme();
  const [open, setOpen] = useState(false);

  return (
    <View>
      <TouchableOpacity
        onPress={() => setOpen(!open)}
        style={[s.dropdownBtn, { backgroundColor: C.inputBg, borderColor: C.border }]}
        activeOpacity={0.7}
      >
        <Text style={[s.dropdownText, { color: C.foreground }]}>{value}</Text>
        <Feather name={open ? 'chevron-up' : 'chevron-down'} size={14} color={C.textMuted} />
      </TouchableOpacity>
      {open && (
        <View style={[s.dropdownList, { backgroundColor: C.elevated, borderColor: C.border }]}>
          {options.map((opt) => (
            <TouchableOpacity
              key={opt}
              onPress={() => { onSelect(opt); setOpen(false); }}
              style={[
                s.dropdownItem,
                { borderColor: C.borderSubtle },
                value === opt && { backgroundColor: C.primarySubtle },
              ]}
            >
              <Text style={[
                s.dropdownItemText,
                { color: C.foreground },
                value === opt && { color: C.accentText, fontWeight: FontWeight.semibold },
              ]}>{opt}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

// ─── Menu Screen ─────────────────────────────────────────────────────────────
function MenuScreen({ onNavigate }: { onNavigate: (screen: Screen) => void }) {
  const { C } = useTheme();

  const options: { screen: Screen; icon: string; title: string; sub: string }[] = [
    { screen: 'chat', icon: 'message-circle', title: 'Chat with Coach Drona', sub: 'Talk progress, PRs, plateaus, or anything on your mind' },
    { screen: 'plan', icon: 'calendar', title: 'Generate Workout Plan', sub: 'Multi-day program tailored to your goals' },
    { screen: 'workout', icon: 'activity', title: 'Generate a Workout', sub: 'Single session designed for today' },
  ];

  return (
    <View style={s.menuContent}>
      {/* Center icon */}
      <View style={s.menuCenter}>
        <View style={[s.menuIconWrap, { backgroundColor: C.primarySubtle }]}>
          <SparkleIcon size={28} color={C.accentText} />
        </View>
        <Text style={[s.menuTitle, { color: C.foreground }]}>What would you like to do?</Text>
        <Text style={[s.menuSub, { color: C.mutedFg }]}>Knows every rep and PR you've logged. Ask, plan, or build.</Text>
      </View>

      {/* Option cards */}
      {options.map((opt, idx) => (
        <Animated.View key={opt.screen} entering={FadeInDown.delay(idx * 80).duration(300)}>
          <TouchableOpacity
            onPress={() => onNavigate(opt.screen)}
            style={[s.optionCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}
            activeOpacity={0.7}
          >
            <View style={[s.optionIconWrap, { backgroundColor: C.primarySubtle }]}>
              <Feather name={opt.icon as any} size={18} color={C.accentText} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[s.optionTitle, { color: C.foreground }]}>{opt.title}</Text>
              <Text style={[s.optionSub, { color: C.mutedFg }]}>{opt.sub}</Text>
            </View>
            <Feather name="chevron-right" size={16} color={C.textMuted} />
          </TouchableOpacity>
        </Animated.View>
      ))}
    </View>
  );
}

// ─── Chat Screen ─────────────────────────────────────────────────────────────
function ChatScreen({
  onBack,
  onSaveRoutine,
  initialPrompt,
  // Clerk user id (null for guests). Keys the persisted conversation store so
  // chat survives the sheet unmount and never leaks across accounts.
  userId,
  // When provided, this chat is opened from an ACTIVE workout. The live
  // session (which lives only in memory until the workout is saved, so the
  // coach's DB tools can't see it) is injected as the opening turn of every
  // request, the greeting is tailored to where the user is, and quick-question
  // chips are shown. Null/undefined \u2192 ordinary coach chat. Workout chats are
  // intentionally ephemeral, so persistence is disabled in that mode.
  workoutContext,
}: {
  onBack: () => void;
  onSaveRoutine: (name: string) => void;
  initialPrompt?: string;
  userId: string | null;
  workoutContext?: WorkoutCoachContext | null;
}) {
  const { C } = useTheme();
  const supabase = useSupabaseClient();
  // Clerk getToken \u2014 used directly to authenticate the streaming SSE fetch.
  // Falls back to null in guest mode (no Clerk key).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const clerkAuth = hasClerkKey ? require('@clerk/clerk-expo').useAuth() : null;
  const getToken: (() => Promise<string | null>) | null = clerkAuth?.getToken ?? null;
  // The starter (visible greeting) the chat opens on. Tailored to workout mode.
  const makeStarter = (): ChatMessage =>
    workoutContext
      ? { id: 'wc-starter', role: 'assistant', content: workoutCoachStarter(workoutContext) }
      : {
          id: '1',
          role: 'assistant',
          content: "I'm Coach Drona. Ask me anything about your training, recovery, or progression. Or say \"create a workout\" and I'll build one for you.",
        };
  // Persisted conversation state (lib/coachConversations). Disabled in workout
  // mode, where the chat is intentionally ephemeral and re-seeded per open.
  const { messages, setMessages, markStarted, startNewChat } = useCoachConversation({
    userId,
    enabled: !workoutContext,
    makeStarter,
  });
  // Re-seed the chat whenever a fresh workout snapshot arrives (the user
  // reopened the coach after logging more sets). Identity is stable within a
  // single open \u2014 the workout screen snapshots once per open \u2014 so this only
  // fires on a genuine reopen, never wiping an in-progress conversation.
  useEffect(() => {
    if (!workoutContext) return;
    setMessages([{ id: 'wc-starter', role: 'assistant', content: workoutCoachStarter(workoutContext) }]);
    setInput('');
  }, [workoutContext]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  // Tracks the in-flight stream so we can abort it on screen dismiss /
  // unmount and avoid late callbacks firing into an unmounted component
  // (also stops burning Anthropic tokens after the user has left).
  const streamRef = useRef<{ abort: () => void } | null>(null);
  useEffect(() => {
    return () => {
      streamRef.current?.abort();
      streamRef.current = null;
    };
  }, []);

  const handleSend = useCallback(async (override?: string) => {
    const text = (override ?? input).trim();
    if (!text || loading) return;

    // Lock the persisted conversation to this in-progress one so a late disk
    // hydrate can't overwrite it with a stale stored conversation.
    markStarted();

    const userMsg: ChatMessage = { id: Date.now().toString(), role: 'user', content: text };
    // Create an empty placeholder assistant message that streams will fill.
    const assistantId = (Date.now() + 1).toString();
    const placeholder: ChatMessage = {
      id: assistantId, role: 'assistant', content: '',
      thinkingPhase: 'Thinking',
    };
    setMessages(prev => [...prev, userMsg, placeholder]);
    setInput('');
    setLoading(true);

    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);

    // In workout mode, prepend the live session as a synthetic user turn so
    // the coach can see what's happening right now (the in-progress sets only
    // exist in memory — its DB tools can't reach them). The visible assistant
    // starter follows it, so turns stay validly alternating. Otherwise the
    // conversation is sent as-is.
    // Cap the resent history to a sliding window of recent turns (see
    // MAX_SENT_MESSAGES). No-op for typical chats; bounds tokens on long ones.
    // messages[0] is the assistant greeting, so the full array alternates from an
    // assistant turn — a window of an even count can start on an assistant
    // message. Anthropic requires the first message to be a user turn, so drop a
    // leading assistant after slicing (the non-workout path sends turns as-is).
    const rawTurns = [...messages, userMsg].slice(-MAX_SENT_MESSAGES);
    const turns = (rawTurns[0]?.role === 'assistant' ? rawTurns.slice(1) : rawTurns)
      .map(m => ({ role: m.role, content: m.content }));
    const allMessages = workoutContext
      ? [{ role: 'user' as const, content: workoutCoachOpener(workoutContext) }, ...turns]
      : turns;

    // Demo / fallback path: hit only when the live coach is unreachable.
    //   - !isSupabaseConfigured: guest/demo build, no backend at all.
    //   - !getToken: Supabase is configured but Clerk isn't (or user is
    //     signed out). The edge function would 401 on us, so use the mock
    //     directly instead of letting callAICoach surface an
    //     AICoachUnavailableError to the user.
    if (!isSupabaseConfigured || !getToken) {
      try {
        const reply = !getToken
          ? { text: getMockResponse(text), citations: [] as Citation[] }
          : await callAICoach(allMessages, supabase);
        setMessages(prev => prev.map(m =>
          m.id === assistantId
            ? { ...m, content: reply.text, citations: reply.citations.length > 0 ? reply.citations : undefined }
            : m
        ));
      } catch (err: any) {
        const errText = err instanceof AICoachUnavailableError
          ? err.message
          : 'Coach Drona is currently unavailable. Try again in a moment.';
        setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: errText } : m));
      }
      setLoading(false);
      return;
    }

    // Streaming path. Auth header is the current Clerk token.
    let token: string | null = null;
    try { token = await getToken(); } catch { token = null; }
    if (!token) {
      setMessages(prev => prev.map(m =>
        m.id === assistantId ? { ...m, content: 'Not signed in. Please sign in again.' } : m
      ));
      setLoading(false);
      return;
    }

    // Abort any prior in-flight stream before starting a new one — the
    // user-facing guard above prevents this in practice (loading=true
    // disables the send button), but cheap insurance against any future
    // code path that lets a second send slip through.
    streamRef.current?.abort();

    // Typewriter buffer — decouples server arrival from UI display so even
    // if the server delivers in chunky bursts the user sees smooth typing.
    // This is how ChatGPT/Claude.ai/Perplexity all do it: the network is
    // bursty, the animation is smooth.
    const typewriter = createTypewriter(assistantId, setMessages, scrollRef);
    streamRef.current = callAICoachStreaming(allMessages, token, {
      onDelta: (chunk) => typewriter.append(chunk),
      onStatus: (phase, payload) => {
        // Translate server phase tokens into friendly UI labels. The labels
        // show up under the spinner while the message bubble is still empty.
        let label = 'Thinking';
        if (phase === 'tool_use') {
          const tools = Array.isArray((payload as { tools?: unknown }).tools)
            ? ((payload as { tools: string[] }).tools)
            : [];
          if (tools.some(t => t.includes('exercise_history'))) label = 'Looking up your sets';
          else if (tools.some(t => t.includes('recent_workouts'))) label = 'Pulling your recent workouts';
          else if (tools.some(t => t.includes('workout_detail'))) label = 'Reviewing that workout';
          else if (tools.some(t => t.includes('muscle_volume'))) label = 'Checking your volume trends';
          else if (tools.some(t => t.includes('query_sql'))) label = 'Querying your training data';
          else label = 'Checking your data';
        }
        setMessages(prev => prev.map(m =>
          m.id === assistantId && m.content === '' ? { ...m, thinkingPhase: label } : m
        ));
      },
      onDone: ({ citations }) => {
        typewriter.finish(() => {
          // Attach citations only AFTER the typewriter has finished animating
          // everything — feels weird if citations appear before the response
          // text has finished typing.
          setMessages(prev => prev.map(m =>
            m.id === assistantId
              ? { ...m, citations: citations && citations.length > 0 ? citations : undefined }
              : m
          ));
          setLoading(false);
          streamRef.current = null;
        });
      },
      onError: (errStr) => {
        typewriter.fail(`Coach Drona error: ${errStr}`);
        setLoading(false);
        streamRef.current = null;
      },
    }, {
      // Phase 1: persist this turn server-side under the active conversation
      // (ordinary chat only; the in-workout chat stays ephemeral, so no id).
      conversationId: workoutContext ? undefined : ensureActiveConversationId(userId),
      clientMsgId: workoutContext ? undefined : userMsg.id,
    });
  }, [input, loading, messages, supabase, getToken, workoutContext, markStarted, setMessages, userId]);

  // Review mode: auto-ask the coach for a session review once the chat opens,
  // so the user doesn't have to type. Fires exactly once per snapshot — the
  // ref latches the snapshot we've already kicked off, and the
  // `messages.length === 1` guard means we only fire while just the starter is
  // present (right after the reset effect above runs). A genuine reopen brings
  // a new snapshot object, which clears the latch and reviews afresh.
  const reviewSentForRef = useRef<WorkoutCoachContext | null>(null);
  useEffect(() => {
    if (workoutContext?.kind !== 'review') return;
    if (reviewSentForRef.current === workoutContext) return;
    if (loading || messages.length !== 1) return;
    reviewSentForRef.current = workoutContext;
    handleSend(workoutCoachReviewRequest(workoutContext));
  }, [workoutContext, messages, loading, handleSend]);

  // Insight seeding: when opened from a dashboard "Coach noticed" card, the
  // card's question rides in as `initialPrompt` and is auto-asked once, exactly
  // like review mode above. Skipped in workout mode (it has its own seeding).
  const seededPromptRef = useRef<string | null>(null);
  useEffect(() => {
    if (workoutContext) return;
    if (!initialPrompt) return;
    if (seededPromptRef.current === initialPrompt) return;
    if (loading || messages.length !== 1) return;
    seededPromptRef.current = initialPrompt;
    handleSend(initialPrompt);
  }, [initialPrompt, workoutContext, loading, messages, handleSend]);

  // Note: keyboard avoidance is handled by AICoachModal's sheet sizing — the
  // parent shrinks the sheet and lifts it via marginBottom (both platforms)
  // so the input naturally sits above the keyboard. No KeyboardAvoidingView
  // here (it doesn't work reliably inside a transparent Modal).
  return (
    <View style={{ flex: 1 }}>
      {/* Header */}
      <View style={[s.screenHeader, { borderColor: C.borderSubtle }]}>
        <TouchableOpacity onPress={onBack} style={[s.backBtn, { backgroundColor: C.muted }]} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back">
          <Feather name="arrow-left" size={16} color={C.foreground} />
        </TouchableOpacity>
        <SparkleIcon size={16} color={C.accentText} />
        <Text style={[s.screenTitle, { color: C.foreground }]}>
          {workoutContext ? 'Coach Drona · Live session' : 'Chat with Coach Drona'}
        </Text>
        {/* New chat: reset to a fresh conversation. Only in ordinary chat (the
            workout chat is per-session) and once there's a conversation to
            clear, so it doesn't clutter an empty greeting. */}
        {!workoutContext && messages.length > 1 && (
          <TouchableOpacity
            onPress={startNewChat}
            style={[s.newChatBtn, { backgroundColor: C.muted }]}
            accessibilityLabel="Start a new chat"
            hitSlop={8}
          >
            <Feather name="plus" size={18} color={C.foreground} />
          </TouchableOpacity>
        )}
      </View>

      {/* Messages */}
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={s.chatMessages}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {messages.map((msg) => (
          <View
            key={msg.id}
            style={[
              s.chatBubble,
              msg.role === 'user'
                ? [s.userBubble, { backgroundColor: Colors.primary }]
                : [s.assistantBubble, { backgroundColor: C.card, borderColor: C.borderSubtle }],
            ]}
          >
            {msg.role === 'assistant' && msg.content === '' ? (
              // Streaming placeholder: phase text + animated dots while we
              // wait on first token. Replaces the bare spinner with something
              // informative ("Thinking", "Checking your data", etc).
              <ThinkingIndicator phase={msg.thinkingPhase ?? 'Thinking'} />
            ) : msg.role === 'assistant' ? (
              // Markdown-flavored rendering: bold, bullet lists, citation pills
              <MessageContent
                content={msg.content}
                citations={msg.citations}
                textColor={C.foreground}
              />
            ) : (
              <Text style={[s.chatText, { color: Colors.primaryFg }]}>{msg.content}</Text>
            )}
            {msg.role === 'assistant' && msg.citations && msg.citations.length > 0 && (
              <CitationList citations={msg.citations} />
            )}
          </View>
        ))}
      </ScrollView>

      {/* Quick-question chips (workout mode only). Shown until the user's
          first turn — a single tap beats typing mid-set. Hidden once the
          conversation is underway to keep the sheet clean. */}
      {workoutContext && workoutContext.kind === 'live' && messages.length <= 1 && !loading && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          // flexGrow:0 stops the horizontal ScrollView from expanding to fill
          // the column's vertical space (which would stretch the chips into
          // tall ovals). It then hugs the chip height.
          style={s.suggestionScroll}
          contentContainerStyle={s.suggestionRow}
        >
          {workoutCoachSuggestions(workoutContext).map((sugg) => (
            <TouchableOpacity
              key={sugg}
              onPress={() => handleSend(sugg)}
              style={[s.suggestionChip, { backgroundColor: C.primarySubtle, borderColor: C.primaryBorder }]}
              activeOpacity={0.7}
            >
              <Text style={[s.suggestionChipText, { color: C.accentText }]}>{sugg}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* Input */}
      <View style={[s.chatInputWrap, { backgroundColor: C.background, borderColor: C.borderSubtle }]}>
        <View style={[s.chatInputBox, { backgroundColor: C.inputBg, borderColor: C.border }]}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder={workoutContext ? 'Ask about this set, a swap, form…' : 'Ask Coach Drona anything...'}
            placeholderTextColor={C.textMuted}
            style={[s.chatInput, { color: C.foreground }]}
            multiline
            maxLength={500}
            onSubmitEditing={() => handleSend()}
            blurOnSubmit
          />
          <TouchableOpacity
            onPress={() => handleSend()}
            disabled={!input.trim() || loading}
            style={[
              s.sendBtn,
              { backgroundColor: input.trim() ? Colors.primary : C.muted },
            ]}
          >
            <Feather name="send" size={16} color={input.trim() ? Colors.primaryFg : C.textMuted} />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

// ─── WorkoutCard (Phase 2.5) ─────────────────────────────────────────────────
// Shared renderer for a single generated workout. Used standalone by
// GenerateWorkoutScreen and as the inner-day card by GeneratePlanScreen.
// Surfaces the coach's `rationale` (workout mode) or the day-level `note`
// (plan mode), plus any per-exercise `note` cues like "RIR 2",
// "hams-focused", or "last set to failure".
function WorkoutCard({
  workout,
  workoutNote,
  showRationale = true,
  animated = false,
  delayMs = 0,
}: {
  workout: GeneratedWorkout;
  workoutNote?: string;
  showRationale?: boolean;
  animated?: boolean;
  delayMs?: number;
}) {
  const { C } = useTheme();
  const exerciseCountLabel = `${workout.exercises.length} exercise${workout.exercises.length === 1 ? '' : 's'}`;
  const durationLabel = workout.estimated_duration_min ? ` · ~${workout.estimated_duration_min} min` : '';
  const Wrapper: any = animated ? Animated.View : View;
  const wrapperProps: any = animated
    ? { entering: FadeInDown.delay(delayMs).duration(300) }
    : {};
  return (
    <Wrapper
      {...wrapperProps}
      style={[s.resultCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}
    >
      <Text style={[s.resultCardTitle, { color: C.foreground }]}>{workout.name}</Text>
      {workout.focus && (
        <Text style={[s.resultCardFocus, { color: C.accentText }]}>{workout.focus}</Text>
      )}
      <Text style={[s.resultCardSub, { color: C.mutedFg }]}>
        {exerciseCountLabel}{durationLabel}
      </Text>

      {workoutNote && (
        <Text style={[s.workoutNoteCaption, { color: C.mutedFg }]}>
          {workoutNote}
        </Text>
      )}

      {showRationale && workout.rationale && (
        <View style={[s.rationaleCallout, { backgroundColor: C.primarySubtle, borderColor: C.borderSubtle }]}>
          <View style={s.rationaleHeader}>
            <Feather name="zap" size={11} color={C.accentText} />
            <Text style={[s.rationaleHeaderText, { color: C.accentText }]}>WHY THIS WORKS FOR YOU</Text>
          </View>
          <Text style={[s.rationaleText, { color: C.foreground }]}>
            {workout.rationale}
          </Text>
        </View>
      )}

      {workout.exercises.map((ex, ei) => (
        <View key={ei} style={[s.resultExRowOuter, { borderColor: C.borderSubtle }]}>
          <View style={s.resultExRowTop}>
            <Text style={[s.resultExName, { color: C.foreground, flex: 1 }]} numberOfLines={2}>{ex.name}</Text>
            <Text style={[s.resultExDetail, { color: C.mutedFg }]}>
              {ex.sets}×{ex.reps} · {ex.rest}
            </Text>
          </View>
          {ex.note && (
            <Text style={[s.resultExNote, { color: C.mutedFg }]} numberOfLines={3}>
              {ex.note}
            </Text>
          )}
        </View>
      ))}
    </Wrapper>
  );
}

// Build the textual recap of a generated plan/workout that we append as the
// "assistant" turn before a refinement, so the model can see what it last
// produced and refine accordingly without us re-implementing tool-result
// plumbing on the client.
function workoutToText(w: GeneratedWorkout): string {
  const lines: string[] = [];
  lines.push(`Name: ${w.name}`);
  if (w.focus) lines.push(`Focus: ${w.focus}`);
  if (w.estimated_duration_min) lines.push(`Estimated duration: ${w.estimated_duration_min} min`);
  if (w.rationale) lines.push(`Rationale: ${w.rationale}`);
  lines.push(`Exercises:`);
  for (const ex of w.exercises) {
    const tail = ex.note ? ` — ${ex.note}` : '';
    lines.push(`  - ${ex.name}: ${ex.sets}×${ex.reps} (${ex.rest})${tail}`);
  }
  return lines.join('\n');
}

function planToText(p: GeneratedPlan): string {
  const lines: string[] = [];
  lines.push(`[Previously generated plan]`);
  lines.push(`Name: ${p.name}`);
  if (p.split_type) lines.push(`Split: ${p.split_type}`);
  if (p.days_per_week) lines.push(`Days/week: ${p.days_per_week}`);
  if (p.rationale) lines.push(`Rationale: ${p.rationale}`);
  for (const w of p.workouts) {
    lines.push('');
    if (w.note) lines.push(`Day note: ${w.note}`);
    lines.push(workoutToText(w));
  }
  return lines.join('\n');
}

// ─── Generate Plan Screen ────────────────────────────────────────────────────
function GeneratePlanScreen({
  onBack,
  onSaveRoutines,
}: {
  onBack: () => void;
  onSaveRoutines: (routines: GeneratedWorkout[]) => void;
}) {
  const { C } = useTheme();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const clerkAuth = hasClerkKey ? require('@clerk/clerk-expo').useAuth() : null;
  const getToken: (() => Promise<string | null>) | null = clerkAuth?.getToken ?? null;

  const [goal, setGoal] = useState('');
  const [days, setDays] = useState('4 days');
  const [sessionLength, setSessionLength] = useState('45-60 min');
  const [level, setLevel] = useState<'Beginner' | 'Intermediate' | 'Advanced'>('Intermediate');
  const [loading, setLoading] = useState(false);
  // Kept for back-compat with the runGeneration signature; the inline
  // refine UI it used to drive has been replaced by the conversational
  // RefineChatScreen, so `refining` only ever transitions to true now
  // if a future caller passes isRefine=true to runGeneration.
  const [refining, setRefining] = useState(false);
  const [coachIntent, setCoachIntent] = useState('');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [result, setResult] = useState<GeneratedPlan | null>(null);
  // Toggled by the "Refine with AI" button on the result view. When true
  // (and result is non-null), we mount RefineChatScreen instead of the
  // result card. The chat hands back the updated plan via onRefined,
  // at which point we clear this flag and the result card re-renders
  // with the refined version.
  const [showRefineChat, setShowRefineChat] = useState(false);
  // Toggled by the "Or chat with Coach Drona to refine" button on the
  // form view. When true (and result is null), we mount RefineChatScreen
  // in 'discuss' kind so the user can talk through the plan with Coach
  // Drona before generation. When Drona emits generate_plan, the same
  // onRefined callback flows into the result card with the Save button.
  // Reuses the refine machinery — same backend mode, same structured
  // output handling — just a different opener and starter.
  const [showDiscussChat, setShowDiscussChat] = useState(false);
  // Conversation history (carries across refinements). Stored in a ref so
  // mid-stream callbacks read the latest value without re-binding.
  const conversationRef = useRef<{ role: string; content: string }[]>([]);
  // Abort handle for the in-flight stream. Cancelled on screen dismiss /
  // unmount so a backgrounded request doesn't keep burning tokens and
  // late callbacks don't land on an unmounted component.
  const streamRef = useRef<{ abort: () => void } | null>(null);
  useEffect(() => {
    return () => {
      streamRef.current?.abort();
      streamRef.current = null;
    };
  }, []);

  const buildInitialPrompt = () =>
    `Design a multi-day training plan for me. Goal: ${goal || 'general fitness'}. ${days}/week, ${sessionLength} sessions, ${level} level. Use my training data to choose appropriate volume, exercise selection, and progression. Give each day a short "note" with its theme and add per-exercise notes for form, intent, or RIR cues. Before calling generate_plan, write one short sentence (5-15 words) signaling your intent.`;

  const runGeneration = async (
    conversation: { role: string; content: string }[],
    isRefine: boolean,
  ) => {
    setErrorText(null);
    setCoachIntent('');
    if (isRefine) setRefining(true);
    else setLoading(true);

    // Guest fallback (no Supabase / no Clerk): minimal mock so the demo UI still works.
    if (!isSupabaseConfigured || !getToken) {
      setTimeout(() => {
        setResult({
          name: 'Demo Plan',
          rationale: 'Demo plan (guest mode). Sign in to get a real coach-designed plan that uses your training data.',
          split_type: 'Push/Pull/Legs',
          days_per_week: 3,
          workouts: [
            {
              name: 'Push Day', note: 'Chest-led, RIR 1-2',
              exercises: [
                { name: 'Bench Press', sets: 4, reps: '6-8', rest: '120s', note: 'Top set heavy, RIR 1' },
                { name: 'Incline DB Press', sets: 3, reps: '8-12', rest: '90s', note: 'Hams of the chest, push hard' },
              ],
            },
            {
              name: 'Pull Day', note: 'Back volume + biceps',
              exercises: [
                { name: 'Pull-ups', sets: 4, reps: '6-10', rest: '120s' },
                { name: 'Barbell Row', sets: 3, reps: '8-10', rest: '90s', note: 'Strict, no body english' },
              ],
            },
          ],
        });
        setLoading(false);
        setRefining(false);
      }, 600);
      return;
    }

    let token: string | null = null;
    try { token = await getToken!(); } catch { token = null; }
    if (!token) {
      setErrorText('Not signed in. Please sign in again.');
      setLoading(false);
      setRefining(false);
      return;
    }

    // Per-invocation flag: did the live `structured` SSE event fire and
    // get handled here, or did the stream end without it? Lets the onDone
    // fallback know whether to ALSO write conversationRef. Using a
    // closure variable instead of a ref because it's stream-scoped, not
    // component-scoped — each runGeneration call gets its own.
    let handledStructured = false;

    // Cancel any prior stream before opening a new one. Belt-and-suspenders
    // — `loading`/`refining` flags already gate the UI, but this prevents
    // any future code path that bypasses them from leaking concurrent
    // streams.
    streamRef.current?.abort();
    streamRef.current = callAICoachStreaming(
      conversation,
      token,
      {
        onDelta: (chunk) => setCoachIntent((prev) => prev + chunk),
        onStructured: ({ name, input }) => {
          if (name === 'generate_plan') {
            handledStructured = true;
            const p = structuredToPlan(input);
            setResult(p);
            conversationRef.current = [
              ...conversation,
              { role: 'assistant', content: planToText(p) },
            ];
            // Loading/refining flags stay set until `done` — `structured`
            // arrives before stream finalization, so flipping flags here
            // would let a quick second refine overlap streams.
          }
        },
        onDone: ({ structured }) => {
          // Defensive fallback if the live `structured` event was missed
          // (e.g. mid-stream reconnect). The previous version checked
          // `!result` from the closure, which is stale on refine turns
          // (already truthy) — so the card updated but conversationRef
          // silently stayed on the previous plan, sending stale context
          // on the next refine. Use the per-call flag instead.
          if (!handledStructured && structured?.name === 'generate_plan') {
            const p = structuredToPlan(structured.input);
            setResult(p);
            conversationRef.current = [
              ...conversation,
              { role: 'assistant', content: planToText(p) },
            ];
          }
          setLoading(false);
          setRefining(false);
          streamRef.current = null;
        },
        onError: (err) => {
          setErrorText(err);
          setLoading(false);
          setRefining(false);
          streamRef.current = null;
        },
      },
      { forceTool: 'generate_plan' },
    );
  };

  const handleGenerate = async () => {
    const prompt = buildInitialPrompt();
    conversationRef.current = [{ role: 'user', content: prompt }];
    await runGeneration(conversationRef.current, false);
  };

  // ── Discuss chat (pre-generate conversational) ──────────────────────────
  // Mounted instead of the form when the user taps "Or chat with Coach
  // Drona to refine" without having generated a plan yet. Coach Drona
  // probes priorities, can pull training data, and on user confirmation
  // emits generate_plan. The structured output flows into setResult via
  // onRefined, dropping the user on the result card with the Save All
  // Routines button — same finish line as form-based generation.
  if (!result && showDiscussChat) {
    return (
      <RefineChatScreen
        kind="discuss"
        mode="refine_plan"
        onBack={() => setShowDiscussChat(false)}
        onRefined={(next) => {
          const p = next as GeneratedPlan;
          setResult(p);
          setShowDiscussChat(false);
          // Seed the conversation ref so a follow-up "Refine with AI"
          // from the result card has the just-built plan as the assistant
          // turn it can reason about.
          conversationRef.current = [
            { role: 'assistant', content: planToText(p) },
          ];
        }}
      />
    );
  }

  // ── Refine chat (conversational) ────────────────────────────────────────
  // Same pattern as GenerateWorkoutScreen — mounted instead of the
  // result card when the user taps "Refine with AI". Each visit seeds
  // the chat with the CURRENT plan so re-entering refine after a
  // successful iteration uses the refined version as context.
  if (result && showRefineChat) {
    return (
      <RefineChatScreen
        kind="refine"
        mode="refine_plan"
        plan={result}
        onBack={() => setShowRefineChat(false)}
        onRefined={(next) => {
          setResult(next as GeneratedPlan);
          setShowRefineChat(false);
        }}
      />
    );
  }

  // ── Result view ─────────────────────────────────────────────────────────
  // No KeyboardAvoidingView here — there is no TextInput on this screen,
  // and the parent AICoachModal already handles iOS keyboard avoidance
  // for any chat sub-screens via its sheet's marginBottom.
  if (result) {
    return (
      <View style={{ flex: 1 }}>
        <View style={[s.screenHeader, { borderColor: C.borderSubtle }]}>
          <TouchableOpacity
            onPress={() => { setResult(null); setShowRefineChat(false); conversationRef.current = []; }}
            style={[s.backBtn, { backgroundColor: C.muted }]}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <Feather name="arrow-left" size={16} color={C.foreground} />
          </TouchableOpacity>
          <SparkleIcon size={16} color={C.accentText} />
          <Text style={[s.screenTitle, { color: C.foreground }]}>Your Plan</Text>
        </View>
        <ScrollView contentContainerStyle={{ padding: Spacing.xl, paddingBottom: 24, gap: 16 }}>
          {/* Plan header + plan-level rationale (the "why" for the whole program) */}
          <Animated.View
            entering={FadeInDown.duration(300)}
            style={[s.resultCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}
          >
            <Text style={[s.resultCardTitle, { color: C.foreground }]}>{result.name}</Text>
            {(result.split_type || result.days_per_week) && (
              <View style={s.planMetaRow}>
                {result.split_type && (
                  <Text style={[s.planMetaText, { color: C.accentText }]}>{result.split_type}</Text>
                )}
                {result.split_type && result.days_per_week && (
                  <Text style={[s.planMetaText, { color: C.mutedFg }]}>·</Text>
                )}
                {result.days_per_week && (
                  <Text style={[s.planMetaText, { color: C.mutedFg }]}>
                    {result.days_per_week} day{result.days_per_week === 1 ? '' : 's'}/week
                  </Text>
                )}
              </View>
            )}
            {result.rationale && (
              <View style={[s.rationaleCallout, { backgroundColor: C.primarySubtle, borderColor: C.borderSubtle }]}>
                <View style={s.rationaleHeader}>
                  <Feather name="zap" size={11} color={C.accentText} />
                  <Text style={[s.rationaleHeaderText, { color: C.accentText }]}>WHY THIS PLAN FITS YOU</Text>
                </View>
                <Text style={[s.rationaleText, { color: C.foreground }]}>{result.rationale}</Text>
              </View>
            )}
          </Animated.View>

          {/* Per-day workout cards — rationale is plan-level, so suppress here */}
          {result.workouts.map((workout, wi) => (
            <WorkoutCard
              key={wi}
              workout={workout}
              workoutNote={workout.note}
              showRationale={false}
              animated
              delayMs={(wi + 1) * 80}
            />
          ))}

          {errorText && (
            <View style={[s.errorBanner, { backgroundColor: C.muted }]}>
              <Feather name="alert-circle" size={14} color={C.textMuted} />
              <Text style={[s.errorBannerText, { color: C.mutedFg }]}>{errorText}</Text>
            </View>
          )}
        </ScrollView>

        {/*
          Action row: "Refine with AI" (secondary) opens RefineChatScreen
          to iterate on the plan conversationally; "Save All Routines"
          (primary) commits each day as a routine. Stacked vertically in
          the same s.refineWrap container the inline refine input used
          to live inside.
        */}
        <View style={[s.refineWrap, { backgroundColor: C.background, borderColor: C.borderSubtle }]}>
          <TouchableOpacity
            onPress={() => setShowRefineChat(true)}
            disabled={refining}
            style={[s.secondaryBtn, { backgroundColor: C.muted }, refining && { opacity: 0.6 }]}
          >
            <Feather name="message-circle" size={14} color={C.mutedFg} />
            <Text style={[s.secondaryBtnText, { color: C.mutedFg }]}>Refine with AI</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => onSaveRoutines(result.workouts)}
            disabled={refining}
            style={[s.primaryBtn, refining && { opacity: 0.6 }]}
          >
            <Feather name="check" size={16} color={Colors.primaryFg} />
            <Text style={s.primaryBtnText}>Save All Routines</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ── Loading state (first generation only — refinement now happens in a
  // separate RefineChatScreen mounted via showRefineChat, not over the card).
  if (loading) {
    return (
      <View style={{ flex: 1 }}>
        <View style={[s.screenHeader, { borderColor: C.borderSubtle }]}>
          <TouchableOpacity onPress={onBack} style={[s.backBtn, { backgroundColor: C.muted }]} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back">
            <Feather name="arrow-left" size={16} color={C.foreground} />
          </TouchableOpacity>
          <SparkleIcon size={16} color={C.accentText} />
          <Text style={[s.screenTitle, { color: C.foreground }]}>Generating…</Text>
        </View>
        <View style={s.loadingWrap}>
          <ActivityIndicator size="small" color={C.accentText} />
          <Text style={[s.loadingHeader, { color: C.foreground }]}>Coach Drona is designing your plan</Text>
          <Text style={[s.loadingIntent, { color: C.mutedFg }]}>
            {coachIntent || 'Reviewing your training history and matching split, volume, and progression…'}
          </Text>
        </View>
      </View>
    );
  }

  // ── Form ────────────────────────────────────────────────────────────────
  return (
    <View style={{ flex: 1 }}>
      <View style={[s.screenHeader, { borderColor: C.borderSubtle }]}>
        <TouchableOpacity onPress={onBack} style={[s.backBtn, { backgroundColor: C.muted }]} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back">
          <Feather name="arrow-left" size={16} color={C.foreground} />
        </TouchableOpacity>
        <SparkleIcon size={16} color={C.accentText} />
        <Text style={[s.screenTitle, { color: C.foreground }]}>Generate Plan</Text>
      </View>

      <ScrollView contentContainerStyle={s.formContent}>
        {/* Goal */}
        <View style={s.formField}>
          <View style={s.formLabelRow}>
            <Feather name="target" size={12} color={C.mutedFg} />
            <Text style={[s.formLabel, { color: C.mutedFg }]}>Your Goal</Text>
          </View>
          <TextInput
            value={goal}
            onChangeText={setGoal}
            placeholder="e.g. Build muscle, lose fat, get stronger..."
            placeholderTextColor={C.textMuted}
            style={[s.formInput, { backgroundColor: C.inputBg, color: C.foreground, borderColor: C.border }]}
          />
        </View>

        {/* Days + Session Length */}
        <View style={s.formRow}>
          <View style={[s.formField, { flex: 1 }]}>
            <View style={s.formLabelRow}>
              <Feather name="calendar" size={12} color={C.mutedFg} />
              <Text style={[s.formLabel, { color: C.mutedFg }]}>Days/Week</Text>
            </View>
            <DropdownPicker options={DAYS_OPTIONS} value={days} onSelect={setDays} />
          </View>
          <View style={[s.formField, { flex: 1 }]}>
            <View style={s.formLabelRow}>
              <Feather name="clock" size={12} color={C.mutedFg} />
              <Text style={[s.formLabel, { color: C.mutedFg }]}>Session Length</Text>
            </View>
            <DropdownPicker options={SESSION_OPTIONS} value={sessionLength} onSelect={setSessionLength} />
          </View>
        </View>

        {/* Experience Level */}
        <View style={s.formField}>
          <View style={s.formLabelRow}>
            <SparkleIcon size={12} color={C.mutedFg} />
            <Text style={[s.formLabel, { color: C.mutedFg }]}>Experience Level</Text>
          </View>
          <View style={[s.levelRow, { borderColor: C.border }]}>
            {(['Beginner', 'Intermediate', 'Advanced'] as const).map((lv) => (
              <TouchableOpacity
                key={lv}
                onPress={() => setLevel(lv)}
                style={[
                  s.levelBtn,
                  level === lv && { backgroundColor: Colors.primary },
                  { borderColor: C.border },
                ]}
              >
                <Text style={[
                  s.levelBtnText,
                  { color: C.mutedFg },
                  level === lv && { color: Colors.primaryFg, fontWeight: FontWeight.semibold },
                ]}>{lv}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {errorText && (
          <View style={[s.errorBanner, { backgroundColor: C.muted }]}>
            <Feather name="alert-circle" size={14} color={C.textMuted} />
            <Text style={[s.errorBannerText, { color: C.mutedFg }]}>{errorText}</Text>
          </View>
        )}

        {/* Generate button */}
        <TouchableOpacity
          onPress={handleGenerate}
          disabled={loading}
          style={[s.primaryBtn]}
        >
          <SparkleIcon size={16} color={Colors.primaryFg} />
          <Text style={s.primaryBtnText}>Generate Plan</Text>
        </TouchableOpacity>

        {/* Chat alternative — opens the discuss flow (RefineChatScreen in
            discuss kind). Coach Drona probes priorities, optionally pulls
            training data, and emits generate_plan on confirmation — at
            which point the user lands on the result card with the Save
            All Routines button. */}
        <TouchableOpacity
          onPress={() => setShowDiscussChat(true)}
          style={[s.secondaryBtn, { backgroundColor: C.muted }]}
        >
          <Feather name="message-circle" size={14} color={C.mutedFg} />
          <Text style={[s.secondaryBtnText, { color: C.mutedFg }]}>Or chat with Coach Drona to refine</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

// ─── Generate Workout Screen ─────────────────────────────────────────────────
function GenerateWorkoutScreen({
  onBack,
  onSaveRoutine,
}: {
  onBack: () => void;
  onSaveRoutine: (workout: GeneratedWorkout) => void;
}) {
  const { C } = useTheme();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const clerkAuth = hasClerkKey ? require('@clerk/clerk-expo').useAuth() : null;
  const getToken: (() => Promise<string | null>) | null = clerkAuth?.getToken ?? null;

  const [focus, setFocus] = useState('');
  const [duration, setDuration] = useState('45 min');
  const [equipment, setEquipment] = useState('Full Gym');
  const [loading, setLoading] = useState(false);
  // Kept for back-compat with the runGeneration signature; the inline
  // refine UI it used to drive has been replaced by the conversational
  // RefineChatScreen, so `refining` only ever transitions to true now
  // if a future caller passes isRefine=true to runGeneration.
  const [refining, setRefining] = useState(false);
  const [coachIntent, setCoachIntent] = useState('');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [result, setResult] = useState<GeneratedWorkout | null>(null);
  // Toggled by the "Refine with AI" button on the result view. When true
  // (and result is non-null), we mount RefineChatScreen instead of the
  // result card. The chat hands back the updated workout via onRefined,
  // at which point we clear this flag and the result card re-renders
  // with the refined version.
  const [showRefineChat, setShowRefineChat] = useState(false);
  // Pre-generate discuss flow — see GeneratePlanScreen for the rationale.
  // Lets the user talk through the workout with Coach Drona before any
  // structured output exists, ending at the same Save Routine button as
  // form-based generation.
  const [showDiscussChat, setShowDiscussChat] = useState(false);
  // Conversation history (carries across refinements). A ref so async
  // streaming callbacks read the latest value without re-binding on each turn.
  const conversationRef = useRef<{ role: string; content: string }[]>([]);
  // See the matching block in GeneratePlanScreen — abort handle for the
  // in-flight stream, cancelled on unmount / dismiss.
  const streamRef = useRef<{ abort: () => void } | null>(null);
  useEffect(() => {
    return () => {
      streamRef.current?.abort();
      streamRef.current = null;
    };
  }, []);

  const buildInitialPrompt = () =>
    `Design a workout for me. Focus: ${focus || 'full body'}. Time available: ${duration}. Equipment: ${equipment}. Use my training data (volume trends, recent workouts, PRs) and pick exercises that fit my goal and experience. Add per-exercise notes for form, intent, or RIR cues. Before calling generate_workout, write one short sentence (5-15 words) signaling your intent.`;

  const runGeneration = async (
    conversation: { role: string; content: string }[],
    isRefine: boolean,
  ) => {
    setErrorText(null);
    setCoachIntent('');
    if (isRefine) setRefining(true);
    else setLoading(true);

    // Guest fallback: minimal mock so the UI demos without a real backend.
    if (!isSupabaseConfigured || !getToken) {
      setTimeout(() => {
        setResult({
          name: focus || 'Workout',
          rationale: 'Demo workout (guest mode). Sign in to get a real coach-designed session that uses your training data.',
          focus: focus || 'Full body',
          exercises: [
            { name: 'Bench Press', sets: 4, reps: '8-10', rest: '90s', note: 'Top set close to failure (RIR 1).' },
            { name: 'Squat', sets: 4, reps: '6-8', rest: '120s', note: 'Heavy, depth over weight.' },
            { name: 'Row', sets: 3, reps: '10-12', rest: '90s' },
          ],
        });
        setLoading(false);
        setRefining(false);
      }, 600);
      return;
    }

    let token: string | null = null;
    try { token = await getToken!(); } catch { token = null; }
    if (!token) {
      setErrorText('Not signed in. Please sign in again.');
      setLoading(false);
      setRefining(false);
      return;
    }

    // Same per-invocation flag + abort discipline as GeneratePlanScreen.
    let handledStructured = false;
    streamRef.current?.abort();
    streamRef.current = callAICoachStreaming(
      conversation,
      token,
      {
        onDelta: (chunk) => setCoachIntent((prev) => prev + chunk),
        onStructured: ({ name, input }) => {
          if (name === 'generate_workout') {
            handledStructured = true;
            const w = structuredToWorkout(input);
            setResult(w);
            conversationRef.current = [
              ...conversation,
              { role: 'assistant', content: workoutToText(w) },
            ];
            // Flags stay set until `done` — see GeneratePlanScreen for the
            // overlapping-stream reasoning.
          }
        },
        onDone: ({ structured }) => {
          // Defensive fallback if the live 'structured' event was missed.
          // Use the per-call flag, NOT a stale `!result` closure (which is
          // truthy on refine turns and would leave conversationRef pointed
          // at the previous workout — next refine would send stale context).
          if (!handledStructured && structured?.name === 'generate_workout') {
            const w = structuredToWorkout(structured.input);
            setResult(w);
            conversationRef.current = [
              ...conversation,
              { role: 'assistant', content: workoutToText(w) },
            ];
          }
          setLoading(false);
          setRefining(false);
          streamRef.current = null;
        },
        onError: (err) => {
          setErrorText(err);
          setLoading(false);
          setRefining(false);
          streamRef.current = null;
        },
      },
      { forceTool: 'generate_workout' },
    );
  };

  const handleGenerate = async () => {
    const prompt = buildInitialPrompt();
    conversationRef.current = [{ role: 'user', content: prompt }];
    await runGeneration(conversationRef.current, false);
  };

  // ── Discuss chat (pre-generate conversational) ──────────────────────────
  // Mounted instead of the form when the user taps "Or chat with Coach
  // Drona to refine" without having generated a workout yet. Same machine
  // as the refine chat — Coach Drona probes priorities and emits
  // generate_workout on confirmation. The structured output drops the
  // user on the result card with the Save Routine button.
  if (!result && showDiscussChat) {
    return (
      <RefineChatScreen
        kind="discuss"
        mode="refine_workout"
        onBack={() => setShowDiscussChat(false)}
        onRefined={(next) => {
          const w = next as GeneratedWorkout;
          setResult(w);
          setShowDiscussChat(false);
          conversationRef.current = [
            { role: 'assistant', content: workoutToText(w) },
          ];
        }}
      />
    );
  }

  // ── Refine chat (conversational) ────────────────────────────────────────
  // Mounted instead of the result card whenever the user taps "Refine
  // with AI". The chat seeds itself with the CURRENT workout (so
  // re-entering refine after a successful iteration uses the refined
  // version as context, not the original). On successful refine, the
  // result state is replaced and we pop back to the card.
  if (result && showRefineChat) {
    return (
      <RefineChatScreen
        kind="refine"
        mode="refine_workout"
        workout={result}
        onBack={() => setShowRefineChat(false)}
        onRefined={(next) => {
          setResult(next as GeneratedWorkout);
          setShowRefineChat(false);
        }}
      />
    );
  }

  // ── Result view ─────────────────────────────────────────────────────────
  // No KeyboardAvoidingView — see GeneratePlanScreen for rationale.
  if (result) {
    return (
      <View style={{ flex: 1 }}>
        <View style={[s.screenHeader, { borderColor: C.borderSubtle }]}>
          <TouchableOpacity
            onPress={() => { setResult(null); setShowRefineChat(false); conversationRef.current = []; }}
            style={[s.backBtn, { backgroundColor: C.muted }]}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <Feather name="arrow-left" size={16} color={C.foreground} />
          </TouchableOpacity>
          <SparkleIcon size={16} color={C.accentText} />
          <Text style={[s.screenTitle, { color: C.foreground }]}>Your Workout</Text>
        </View>
        <ScrollView contentContainerStyle={{ padding: Spacing.xl, paddingBottom: 24, gap: 16 }}>
          <WorkoutCard workout={result} animated />
          {errorText && (
            <View style={[s.errorBanner, { backgroundColor: C.muted }]}>
              <Feather name="alert-circle" size={14} color={C.textMuted} />
              <Text style={[s.errorBannerText, { color: C.mutedFg }]}>{errorText}</Text>
            </View>
          )}
        </ScrollView>

        {/*
          Action row: "Refine with AI" (secondary) opens RefineChatScreen
          to iterate conversationally; "Save as Routine" (primary)
          commits the current workout. Stacked vertically — the same
          s.refineWrap container the inline refine input used to live
          inside, so spacing/borders stay consistent with the prior
          layout.
        */}
        <View style={[s.refineWrap, { backgroundColor: C.background, borderColor: C.borderSubtle }]}>
          <TouchableOpacity
            onPress={() => setShowRefineChat(true)}
            disabled={refining}
            style={[s.secondaryBtn, { backgroundColor: C.muted }, refining && { opacity: 0.6 }]}
          >
            <Feather name="message-circle" size={14} color={C.mutedFg} />
            <Text style={[s.secondaryBtnText, { color: C.mutedFg }]}>Refine with AI</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => onSaveRoutine(result)}
            disabled={refining}
            style={[s.primaryBtn, refining && { opacity: 0.6 }]}
          >
            <Feather name="check" size={16} color={Colors.primaryFg} />
            <Text style={s.primaryBtnText}>Save as Routine</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ── Loading state ───────────────────────────────────────────────────────
  if (loading) {
    return (
      <View style={{ flex: 1 }}>
        <View style={[s.screenHeader, { borderColor: C.borderSubtle }]}>
          <TouchableOpacity onPress={onBack} style={[s.backBtn, { backgroundColor: C.muted }]} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back">
            <Feather name="arrow-left" size={16} color={C.foreground} />
          </TouchableOpacity>
          <SparkleIcon size={16} color={C.accentText} />
          <Text style={[s.screenTitle, { color: C.foreground }]}>Generating…</Text>
        </View>
        <View style={s.loadingWrap}>
          <ActivityIndicator size="small" color={C.accentText} />
          <Text style={[s.loadingHeader, { color: C.foreground }]}>Coach Drona is designing your workout</Text>
          <Text style={[s.loadingIntent, { color: C.mutedFg }]}>
            {coachIntent || 'Pulling your training data and matching exercises…'}
          </Text>
        </View>
      </View>
    );
  }

  // ── Form ────────────────────────────────────────────────────────────────
  return (
    <View style={{ flex: 1 }}>
      <View style={[s.screenHeader, { borderColor: C.borderSubtle }]}>
        <TouchableOpacity onPress={onBack} style={[s.backBtn, { backgroundColor: C.muted }]} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back">
          <Feather name="arrow-left" size={16} color={C.foreground} />
        </TouchableOpacity>
        <SparkleIcon size={16} color={C.accentText} />
        <Text style={[s.screenTitle, { color: C.foreground }]}>Generate Workout</Text>
      </View>

      <ScrollView contentContainerStyle={s.formContent}>
        {/* Focus Area */}
        <View style={s.formField}>
          <View style={s.formLabelRow}>
            <Feather name="target" size={12} color={C.mutedFg} />
            <Text style={[s.formLabel, { color: C.mutedFg }]}>Focus Area</Text>
          </View>
          <TextInput
            value={focus}
            onChangeText={setFocus}
            placeholder="e.g. Chest & shoulders, legs, full body..."
            placeholderTextColor={C.textMuted}
            style={[s.formInput, { backgroundColor: C.inputBg, color: C.foreground, borderColor: C.border }]}
          />
          {/* Quick picks */}
          <View style={s.quickPicks}>
            {FOCUS_PICKS.map((pick) => (
              <TouchableOpacity
                key={pick}
                onPress={() => setFocus(pick)}
                style={[
                  s.quickPick,
                  { borderColor: C.border },
                  focus === pick && { backgroundColor: Colors.primary, borderColor: Colors.primary },
                ]}
              >
                <Text style={[
                  s.quickPickText,
                  { color: C.mutedFg },
                  focus === pick && { color: Colors.primaryFg },
                ]}>{pick}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Duration + Equipment */}
        <View style={s.formRow}>
          <View style={[s.formField, { flex: 1 }]}>
            <View style={s.formLabelRow}>
              <Feather name="clock" size={12} color={C.mutedFg} />
              <Text style={[s.formLabel, { color: C.mutedFg }]}>Duration</Text>
            </View>
            <DropdownPicker options={DURATION_OPTIONS} value={duration} onSelect={setDuration} />
          </View>
          <View style={[s.formField, { flex: 1 }]}>
            <View style={s.formLabelRow}>
              <Feather name="tool" size={12} color={C.mutedFg} />
              <Text style={[s.formLabel, { color: C.mutedFg }]}>Equipment</Text>
            </View>
            <DropdownPicker options={EQUIPMENT_OPTIONS} value={equipment} onSelect={setEquipment} />
          </View>
        </View>

        {errorText && (
          <View style={[s.errorBanner, { backgroundColor: C.muted }]}>
            <Feather name="alert-circle" size={14} color={C.textMuted} />
            <Text style={[s.errorBannerText, { color: C.mutedFg }]}>{errorText}</Text>
          </View>
        )}

        {/* Generate button */}
        <TouchableOpacity
          onPress={handleGenerate}
          disabled={loading}
          style={[s.primaryBtn]}
        >
          <SparkleIcon size={16} color={Colors.primaryFg} />
          <Text style={s.primaryBtnText}>Generate Workout</Text>
        </TouchableOpacity>

        {/* Chat alternative — opens the discuss flow. See the matching
            block in GeneratePlanScreen. */}
        <TouchableOpacity
          onPress={() => setShowDiscussChat(true)}
          style={[s.secondaryBtn, { backgroundColor: C.muted }]}
        >
          <Feather name="message-circle" size={14} color={C.mutedFg} />
          <Text style={[s.secondaryBtnText, { color: C.mutedFg }]}>Or chat with Coach Drona first</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

// ─── Pure-affirmative detector (refine safety net) ───────────────────────────
// True when the user's message is essentially "yes — go". Used by
// RefineChatScreen to set forceTool on the next stream, which guarantees
// the model emits the refined workout/plan via tool_use instead of writing
// it as text in the chat (which would be unsaveable). Conservative on
// purpose: we DON'T want to match "yes but bump volume" or "yes, change
// the bench to incline" — those are still substantive turns and the model
// should be free to chat or refine without being forced. So we require
// the cleaned text to be a short stand-alone affirmation.
function isPureAffirmative(text: string): boolean {
  // Strip trailing punctuation and lowercase. Keep length budget tight —
  // anything past ~30 chars is almost certainly carrying additional intent
  // beyond the affirmation.
  const clean = text.trim().toLowerCase().replace(/[.!?,]+$/, '');
  if (clean.length === 0 || clean.length > 30) return false;
  const patterns: RegExp[] = [
    /^yes$/,
    /^yeah$/,
    /^yep$/,
    /^yup$/,
    /^sure$/,
    /^ok$/,
    /^okay$/,
    /^go$/,
    /^go ahead$/,
    /^do it$/,
    /^let'?s do it$/,
    /^let'?s go$/,
    /^sounds good$/,
    /^looks good$/,
    /^perfect$/,
    /^great$/,
    /^alright$/,
    /^please$/,
    /^yes please$/,
    /^yes go ahead$/,
    /^go for it$/,
    /^proceed$/,
    /^definitely$/,
    /^absolutely$/,
    /^confirm$/,
    // "build" / "build it" family — common in discuss flows where the user
    // is approving the proposed structure and asking for the build. Mirror
    // each variant for yes/yeah/yep/yup + build to catch typical phrasings
    // like "yep build", "yes build it", "yeah build it now".
    /^build$/,
    /^build it$/,
    /^build it now$/,
    /^build the (plan|workout)$/,
    /^build it please$/,
    /^(yes|yeah|yep|yup|ok|okay|sure) build$/,
    /^(yes|yeah|yep|yup|ok|okay|sure) build it$/,
    /^(yes|yeah|yep|yup|ok|okay|sure) build it now$/,
    /^(yes|yeah|yep|yup|ok|okay|sure)[, ]+(go|do it|build it)$/,
    /^make it$/,
    /^create it$/,
    /^let'?s build$/,
    /^let'?s build it$/,
    /^confirmed$/,
    /^finalize$/,
    /^finalise$/,
    /^generate$/,
    /^generate it$/,
    /^generate the (plan|workout)$/,
  ];
  return patterns.some(p => p.test(clean));
}

// ─── Refine Chat Screen ──────────────────────────────────────────────────────
// Conversational refinement of a just-generated workout or plan. Opens from
// the result view's "Refine with AI" button. Seeds the chat with a tailored
// starter asking what's not quite working, then lets the user iterate via
// normal chat turns. The backend (refine_workout / refine_plan modes) is
// instructed to probe priorities, optionally pull training data, and ASK
// EXPLICIT CONFIRMATION before emitting the refined structured output. When
// the model finally calls generate_workout / generate_plan, we hand the new
// result back to the parent screen, which dismisses the chat and updates
// the result card.
//
// State design: the chat is intentionally short-lived. Each visit gets a
// fresh conversation seeded with the CURRENT state of the workout/plan —
// re-opening refine after a successful round trip starts a new chat with
// the refined workout as context, not the original. This matches user
// intent ("refine the thing I'm looking at right now") and keeps the
// conversation focused on the next round of changes.
function RefineChatScreen({
  kind = 'refine',
  mode,
  workout,
  plan,
  onBack,
  onRefined,
}: {
  // 'refine' — iterating on an already-generated workout/plan (workout or
  // plan must be provided). 'discuss' — talking with Coach Drona BEFORE any
  // workout/plan exists, to clarify priorities; on confirmation she emits
  // the terminal tool and the same onRefined callback fires with the newly
  // generated structured output. Both kinds use the same backend mode
  // (refine_workout / refine_plan) because refine modes already expose
  // both read tools and the matching terminal tool — exactly what discuss
  // needs.
  kind?: 'refine' | 'discuss';
  mode: 'refine_workout' | 'refine_plan';
  workout?: GeneratedWorkout;
  plan?: GeneratedPlan;
  onBack: () => void;
  // Caller updates its `result` state with this and pops back to the
  // result view. The parent decides whether to remount the chat (next
  // "Refine with AI" tap) with the new state as context.
  onRefined: (next: GeneratedWorkout | GeneratedPlan) => void;
}) {
  const { C } = useTheme();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const clerkAuth = hasClerkKey ? require('@clerk/clerk-expo').useAuth() : null;
  const getToken: (() => Promise<string | null>) | null = clerkAuth?.getToken ?? null;

  // Pre-compute the recap and the tailored starter. These live as the
  // first two conversation turns (synthetic user recap, then assistant
  // starter) so the model sees the live state on every request. We keep
  // them out of `messages` to avoid rendering the verbose recap inside
  // the chat UI — the user already sees the workout/plan card on the
  // screen they came from, no need to duplicate it.
  // In 'discuss' kind there's no existing workout/plan, so recap is null
  // and the synthetic opener is reframed as "discuss before build" instead
  // of "here's the recap, refine it."
  const recapText = kind === 'discuss'
    ? null
    : (mode === 'refine_plan'
        ? planToText(plan!)
        : workoutToText(workout!));

  const starterText = (() => {
    if (kind === 'discuss') {
      return mode === 'refine_plan'
        ? "I'm Coach Drona. Let's talk through your plan before I build it. Tell me what matters most — goal, days per week, session length, exercise preferences, recovery, equipment, anything else on your mind. When you're set, I'll build it."
        : "I'm Coach Drona. Let's talk through your workout before I build it. Tell me what you're after — target muscles, intensity, equipment, time you've got, anything else. When you're set, I'll build it.";
    }
    return mode === 'refine_plan'
      ? (plan!.split_type
          ? `You're looking at "${plan!.name}" — a ${plan!.split_type} structure${plan!.days_per_week ? ` over ${plan!.days_per_week} days/week` : ''}. Before I tweak it: what's not quite hitting the mark? Could be the split, volume per session, exercise selection, time, equipment, or recovery between sessions.`
          : `You're looking at "${plan!.name}". Before I tweak it: what's not quite hitting the mark? Could be the structure, volume, exercises, time, equipment, or recovery.`)
      : (workout!.focus
          ? `You're looking at "${workout!.name}" — ${workout!.focus.toLowerCase()}. Before I tweak it: what's not quite right? Could be exercise selection, volume, sets or reps, rest, time, or something specific you want different.`
          : `You're looking at "${workout!.name}". Before I tweak it: what's not quite right? Exercise selection, volume, sets or reps, rest, time — what's on your mind?`);
  })();

  // Messages rendered in the chat. Starts with just the assistant
  // starter; the recap is sent as a synthetic user message at the API
  // layer but never displayed in the UI.
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: 'starter', role: 'assistant', content: starterText },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  // Stable abort handle — refine turns can run long when the model
  // decides to fetch the user's volume series before proposing changes.
  const streamRef = useRef<{ abort: () => void } | null>(null);
  // Latch so onRefined fires exactly once per stream even when the
  // structured payload arrives in BOTH the live `structured` event and
  // the `done` fallback. Without this, a clean stream would double-fire
  // (caller pops twice → likely a no-op the second time but unsafe).
  const refinedFiredRef = useRef(false);
  // Buffer for the live `structured` payload. We do NOT pop the screen the
  // instant it arrives — that would unmount RefineChatScreen mid-stream and
  // the cleanup effect above would abort the still-running request, killing
  // the promised "finish the closing text, then transition" flow. Instead we
  // stash it here and apply it from onDone's typewriter-finish callback.
  const pendingStructuredRef = useRef<{ name: string; input: Record<string, unknown> } | null>(null);
  useEffect(() => {
    return () => {
      streamRef.current?.abort();
      streamRef.current = null;
    };
  }, []);

  // Translate a terminal-tool emission into the right shape and hand it
  // up. Guards against double-fire (live + done) and against tool-name
  // mismatch (the model picking generate_workout in refine_plan mode is
  // theoretically possible — we just ignore it).
  const handleStructured = useCallback((name: string, input: Record<string, unknown>) => {
    if (refinedFiredRef.current) return;
    if (mode === 'refine_workout' && name === 'generate_workout') {
      refinedFiredRef.current = true;
      onRefined(structuredToWorkout(input));
    } else if (mode === 'refine_plan' && name === 'generate_plan') {
      refinedFiredRef.current = true;
      onRefined(structuredToPlan(input));
    }
  }, [mode, onRefined]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: ChatMessage = { id: Date.now().toString(), role: 'user', content: text };
    const assistantId = (Date.now() + 1).toString();
    const placeholder: ChatMessage = {
      id: assistantId, role: 'assistant', content: '',
      thinkingPhase: 'Thinking',
    };
    setMessages(prev => [...prev, userMsg, placeholder]);
    setInput('');
    setLoading(true);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);

    // Build the API conversation. Order matters: the synthetic opener
    // (user) primes the model with the live state and intent; the starter
    // (assistant) is what the user actually saw on the screen; the rest
    // of `messages` is the real chat history (excluding the seeded
    // starter, which is already represented); then the new user turn.
    // The synthetic opener differs by kind: refine pastes the existing
    // plan/workout as a recap; discuss explicitly tells the model there's
    // nothing yet and to probe before emitting the terminal tool.
    // For discuss kind, the system-prompt DISCUSS_BEHAVIOR carries the full
    // probe-propose-confirm-emit policy — so the synthetic opener stays
    // short and just states the intent. Stuffing instructions into the
    // user turn risks the model treating them as user-supplied (and
    // therefore optional) overrides. For refine kind, the opener carries
    // the recap because the model needs the live state of the workout/plan.
    const syntheticOpener = kind === 'discuss'
      ? (mode === 'refine_plan'
          ? "I want to build a new training plan. Let's discuss what should be in it before you write it."
          : "I want to build a new workout. Let's discuss what should be in it before you write it.")
      : `Here's the current ${mode === 'refine_plan' ? 'plan' : 'workout'} you generated for me. I'd like to refine it.\n\n${recapText}`;

    const apiMessages = [
      { role: 'user' as const, content: syntheticOpener },
      { role: 'assistant' as const, content: starterText },
      ...messages.slice(1).map((m) => ({ role: m.role, content: m.content })),
      { role: userMsg.role, content: userMsg.content },
    ];

    // Safety net for over-conversational models: if this turn is a pure
    // affirmation ("yes", "go ahead", "do it", etc.) AND the user has
    // already had at least one substantive turn in this chat, force the
    // terminal tool on the next stream. Without this, the model
    // sometimes ignores the system prompt and writes the refined workout
    // as text in the chat — which the user can't save. The first-user-
    // turn guard prevents forcing when the user opens refine and
    // immediately types "yes" (no priorities expressed yet → forcing
    // would just regenerate the same workout). messages[0] is the
    // assistant starter, so prior user turns = users-in-history > 0
    // BEFORE we added userMsg.
    const priorUserTurns = messages.filter((m) => m.role === 'user').length;
    const shouldForceTool = isPureAffirmative(text) && priorUserTurns >= 1;
    // The terminal tool the model will call for THIS mode (refine/discuss
    // both map plan→generate_plan, workout→generate_workout).
    const wantsPlan = mode === 'refine_plan';
    const forceToolName: 'generate_workout' | 'generate_plan' =
      wantsPlan ? 'generate_plan' : 'generate_workout';
    // The mode actually sent to the edge function: discuss kind translates
    // to discuss_* (different system-prompt branch with no recap
    // assumption — fixes the "no access to tool" hallucination the model
    // produced when refine_plan was used with no recap). Refine kind
    // passes the mode through unchanged.
    const effectiveMode: 'refine_workout' | 'refine_plan' | 'discuss_workout' | 'discuss_plan' =
      kind === 'discuss'
        ? (wantsPlan ? 'discuss_plan' : 'discuss_workout')
        : mode;

    // Guest / no-Clerk: degrade to a notice in-chat. We can't refine
    // without the live coach. The Generate screens have their own mock
    // result so the user still gets to demo the rest of the flow.
    if (!isSupabaseConfigured || !getToken) {
      setTimeout(() => {
        setMessages(prev => prev.map(m =>
          m.id === assistantId
            ? { ...m, content: 'Refine needs the live coach. Sign in to iterate on your workout.' }
            : m
        ));
        setLoading(false);
      }, 400);
      return;
    }

    let token: string | null = null;
    try { token = await getToken(); } catch { token = null; }
    if (!token) {
      setMessages(prev => prev.map(m =>
        m.id === assistantId ? { ...m, content: 'Not signed in. Please sign in again.' } : m
      ));
      setLoading(false);
      return;
    }

    streamRef.current?.abort();
    const typewriter = createTypewriter(assistantId, setMessages, scrollRef);
    streamRef.current = callAICoachStreaming(apiMessages, token, {
      onDelta: (chunk) => typewriter.append(chunk),
      onStatus: (phase, payload) => {
        let label = 'Thinking';
        if (phase === 'tool_use') {
          const tools = Array.isArray((payload as { tools?: unknown }).tools)
            ? ((payload as { tools: string[] }).tools)
            : [];
          if (tools.some(t => t.includes('exercise_history'))) label = 'Looking up your sets';
          else if (tools.some(t => t.includes('recent_workouts'))) label = 'Pulling your recent workouts';
          else if (tools.some(t => t.includes('workout_detail'))) label = 'Reviewing that workout';
          else if (tools.some(t => t.includes('muscle_volume'))) label = 'Checking your volume trends';
          else if (tools.some(t => t.includes('query_sql'))) label = 'Querying your training data';
          else label = 'Checking your data';
        } else if (phase === 'refining') {
          label = 'Thinking';
        }
        setMessages(prev => prev.map(m =>
          m.id === assistantId && m.content === '' ? { ...m, thinkingPhase: label } : m
        ));
      },
      onStructured: ({ name, input }) => {
        // Model emitted the refined output. Buffer it — do NOT pop here, or
        // we'd unmount the screen mid-stream and abort the request. The
        // transition happens from the typewriter-finish callback below, after
        // the assistant's closing text has landed on screen.
        pendingStructuredRef.current = { name, input };
      },
      onDone: ({ structured }) => {
        typewriter.finish(() => {
          setLoading(false);
          streamRef.current = null;
          // Now that the closing text has finished animating, apply the
          // structured payload — preferring the buffered live event, falling
          // back to the one on the `done` frame (e.g. if the live event was
          // missed mid-stream reconnect). Idempotent thanks to refinedFiredRef.
          const finalStructured = pendingStructuredRef.current ?? structured;
          if (finalStructured) {
            handleStructured(finalStructured.name, finalStructured.input);
          }
          pendingStructuredRef.current = null;
        });
      },
      onError: (errStr) => {
        typewriter.fail(`Coach Drona error: ${errStr}`);
        setLoading(false);
        streamRef.current = null;
      },
    }, {
      mode: effectiveMode,
      // forceTool is the escape hatch for pure-affirmative turns —
      // guarantees the model emits structured output instead of writing
      // the refined workout as text in the chat. Backend accepts both
      // `mode` (system prompt + toolkit) and `force_tool` (tool_choice)
      // simultaneously when the forced tool is in the mode's toolkit,
      // which is true for all refine_*+generate_* and discuss_*+generate_*
      // combinations.
      ...(shouldForceTool ? { forceTool: forceToolName } : {}),
    });
  }, [input, loading, messages, getToken, recapText, starterText, mode, kind, handleStructured]);

  // See ChatScreen — keyboard avoidance lives at the AICoachModal sheet
  // level (marginBottom + dynamic height), not via KeyboardAvoidingView,
  // which is unreliable inside a transparent Modal on iOS.
  return (
    <View style={{ flex: 1 }}>
      {/* Header */}
      <View style={[s.screenHeader, { borderColor: C.borderSubtle }]}>
        <TouchableOpacity onPress={onBack} style={[s.backBtn, { backgroundColor: C.muted }]} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back">
          <Feather name="arrow-left" size={16} color={C.foreground} />
        </TouchableOpacity>
        <SparkleIcon size={16} color={C.accentText} />
        <Text style={[s.screenTitle, { color: C.foreground }]}>
          {kind === 'discuss' ? 'Discuss' : 'Refine'} {mode === 'refine_plan' ? 'Plan' : 'Workout'}
        </Text>
      </View>

      {/* Messages */}
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={s.chatMessages}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {messages.map((msg) => (
          <View
            key={msg.id}
            style={[
              s.chatBubble,
              msg.role === 'user'
                ? [s.userBubble, { backgroundColor: Colors.primary }]
                : [s.assistantBubble, { backgroundColor: C.card, borderColor: C.borderSubtle }],
            ]}
          >
            {msg.role === 'assistant' && msg.content === '' ? (
              <ThinkingIndicator phase={msg.thinkingPhase ?? 'Thinking'} />
            ) : msg.role === 'assistant' ? (
              <MessageContent
                content={msg.content}
                citations={msg.citations}
                textColor={C.foreground}
              />
            ) : (
              <Text style={[s.chatText, { color: Colors.primaryFg }]}>{msg.content}</Text>
            )}
            {msg.role === 'assistant' && msg.citations && msg.citations.length > 0 && (
              <CitationList citations={msg.citations} />
            )}
          </View>
        ))}
      </ScrollView>

      {/* Input */}
      <View style={[s.chatInputWrap, { backgroundColor: C.background, borderColor: C.borderSubtle }]}>
        <View style={[s.chatInputBox, { backgroundColor: C.inputBg, borderColor: C.border }]}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder="Tell me what to change…"
            placeholderTextColor={C.textMuted}
            style={[s.chatInput, { color: C.foreground }]}
            multiline
            maxLength={500}
            onSubmitEditing={handleSend}
            blurOnSubmit
          />
          <TouchableOpacity
            onPress={handleSend}
            disabled={!input.trim() || loading}
            style={[
              s.sendBtn,
              { backgroundColor: input.trim() ? Colors.primary : C.muted },
            ]}
          >
            <Feather name="send" size={16} color={input.trim() ? Colors.primaryFg : C.textMuted} />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

// ─── Main Modal ──────────────────────────────────────────────────────────────
export function AICoachModal({
  visible,
  onClose,
  onRoutineCreated,
  initialScreen = 'menu',
  initialPrompt,
  workoutContext,
}: {
  visible: boolean;
  onClose: () => void;
  onRoutineCreated?: () => void;
  initialScreen?: Screen;
  // When set (from a dashboard insight card), the chat auto-asks this question
  // once on open. Pass initialScreen="chat" alongside it.
  initialPrompt?: string;
  // When set, the chat screen runs in in-workout mode: the live session is
  // injected as context, the greeting is tailored, quick-question chips show,
  // and the chat's back arrow closes the sheet (there's no menu detour
  // mid-workout). Callers pass initialScreen="chat" alongside this.
  workoutContext?: WorkoutCoachContext | null;
}) {
  const { C } = useTheme();
  const { user } = useClerkUser();
  const supabase = useSupabaseClient();
  const toast = useToast();
  const [screen, setScreen] = useState<Screen>(initialScreen);
  // Phase 3 gate. Calls get_coach_access_status. Cached at the hook layer
  // so opening/closing the modal is free after the first fetch. While
  // loading, render the gate's spinner instead of the menu — flashing a
  // menu the user can't use would be worse than waiting 100ms.
  const { access, loading: accessLoading, refresh: refreshAccess } = useCoachAccess();
  const accessAllowed = !accessLoading
    && (access.state === 'paid' || access.state === 'trialing');
  // Manual paywall — opened by the upgrade banner on trialing users' menu.
  // Closing returns to the menu; a successful purchase calls refreshAccess
  // (state → 'paid') which makes the banner disappear on the next render.
  const [showPaywall, setShowPaywall] = useState(false);
  // Reset paywall flag whenever the modal closes/reopens, so stale state
  // from a previous session doesn't auto-show it the next time around.
  useEffect(() => {
    if (!visible) setShowPaywall(false);
  }, [visible]);
  // Sub-frame double-tap guard — modal closes immediately on save, so the
  // visible-button block goes away fast, but the close animation leaves a tiny
  // window where a second tap could fire before React re-renders.
  const inFlightRef = useRef(false);

  // Keyboard avoidance for the modal sheet. A transparent <Modal> does NOT
  // resize when the keyboard appears — on iOS the modal never resizes, and on
  // Android this sheet lives inside a <Modal> (a separate window) which, under
  // SDK 54's always-on edge-to-edge, the activity's adjustResize never reaches.
  // So a nested KeyboardAvoidingView would just add padding BELOW the visible
  // window and the input would stay hidden behind the keyboard. The reliable
  // fix (already used by analytics.tsx's BottomDrawer) is to track keyboard
  // height ourselves and physically lift the sheet via marginBottom + cap its
  // height to (winH - kbHeight) so the top doesn't get pushed off-screen.
  const { height: winH } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [kbHeight, setKbHeight] = useState(0);
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
  // Sheet sizing: when keyboard is up, cap height to the available space
  // above it (minus a small top buffer) so the sheet doesn't overflow the
  // viewport. When keyboard is down, fall back to the original 92% height.
  // Lift by the keyboard height on BOTH platforms. The old code only lifted
  // on iOS, assuming Android's adjustResize would shift the input up — but
  // this sheet lives inside a React Native <Modal> (a separate window) and,
  // with edge-to-edge always on in SDK 54, that window is never resized for
  // the keyboard. The sheet is bottom-anchored, so without the lift the input
  // stays pinned behind the keyboard and the user can't see what they type.
  const sheetHeight = kbHeight > 0
    ? Math.max(winH - kbHeight - 40, winH * 0.5)
    : winH * 0.92;
  const sheetMarginBottom = kbHeight;

  useEffect(() => {
    if (visible) setScreen(initialScreen);
  }, [visible, initialScreen]);

  const router = useRouter();

  const handleClose = () => {
    setScreen('menu');
    onClose();
  };

  // Sign-in path for the gate's unauthenticated state. Close the coach sheet,
  // then route to the auth screen so the blocked flow is actually completable
  // (otherwise the gate's only CTA just dismisses — a dead end). When Clerk
  // isn't configured there's no auth screen to reach, so just close.
  const handleRequestSignIn = () => {
    handleClose();
    if (hasClerkKey) router.push('/(auth)');
  };

  // <Portal> has no onRequestClose, so route the Android hardware back button.
  // Mirror the on-screen affordances instead of always closing the whole
  // sheet: from chat/plan/workout the visible back arrow returns to the menu,
  // so hardware back should too — otherwise Android back throws away the
  // user's in-progress form or conversation. Re-subscribes when the relevant
  // state changes so the handler never acts on a stale screen.
  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      // Gate or menu owns the modal → close it entirely (nothing to lose).
      if (!accessAllowed || screen === 'menu') { handleClose(); return true; }
      // Paywall overlay (trialing upgrade) → dismiss back to the menu.
      if (showPaywall) { setShowPaywall(false); return true; }
      // Chat opened from an active workout has no menu to return to — its
      // back arrow closes, so match that.
      if (screen === 'chat' && workoutContext) { handleClose(); return true; }
      // chat / plan / workout → step back to the menu.
      setScreen('menu');
      return true;
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, accessAllowed, screen, showPaywall, workoutContext]);

  const insertRoutineToBackend = async (workout: GeneratedWorkout) => {
    const clerkId = user?.id;
    if (!isSupabaseConfigured || !clerkId) {
      const routineId = `guest-r-${Date.now()}`;
      addGuestRoutine({
        id: routineId,
        user_id: 'guest',
        name: workout.name,
        description: undefined as any,
        color: undefined as any,
        created_at: new Date().toISOString(),
        routine_exercises: workout.exercises.map((ex, i) => {
          const repsArr = ex.reps.split('-').map(Number);
          return {
            id: `gre-${Date.now()}-${i}`,
            exercise_id: `gex-${Date.now()}-${i}`,
            order: i,
            sets: ex.sets,
            reps_min: repsArr[0] || 8,
            reps_max: repsArr[1] || repsArr[0] || 12,
            rest_seconds: parseInt(ex.rest) || 60,
            // Parity with the authenticated branch — guest users keep
            // their cues too. Otherwise the routine renders without
            // notes the moment they save it.
            note: ex.note ?? null,
            exercises: {
              id: `gex-${Date.now()}-${i}`,
              name: ex.name,
              muscle_group: 'Other',
              category: 'Other',
            },
          };
        }),
      });
      return;
    }
    const { data: routine, error } = await supabase
      .from('routines')
      .insert({ user_id: clerkId, name: workout.name })
      .select()
      .single();

    if (error || !routine) throw error || new Error('Failed to create routine');

    // Resolve all exercises in parallel — each one does select + optional insert + link insert.
    // Drops save time from N*(2-3) sequential round trips to ~3 round trips total.
    await Promise.all(workout.exercises.map(async (ex, i) => {
      // Case-insensitive find, oldest row first — .single() would error when a
      // global library row and a same-named custom both match (legal scopes
      // under migration 0037's unique indexes).
      const findByName = async () => {
        const { data } = await supabase
          .from('exercises')
          .select('id')
          .ilike('name', ex.name)
          .order('created_at', { ascending: true })
          .limit(1);
        return data?.[0]?.id;
      };

      let exerciseId = await findByName();
      if (!exerciseId) {
        const { data: newEx, error: insErr } = await supabase
          .from('exercises')
          .insert({ name: ex.name, muscle_group: 'Other', category: 'Other' })
          .select('id')
          .single();
        // 23505: lost the create race to another session — take the winner.
        exerciseId = newEx?.id ?? (insErr?.code === '23505' ? await findByName() : undefined);
      }
      if (!exerciseId) return;

      const repsArr = ex.reps.split('-').map(Number);
      const { error: linkErr } = await supabase.from('routine_exercises').insert({
        routine_id: routine.id,
        exercise_id: exerciseId,
        sets: ex.sets,
        reps_min: repsArr[0] || 8,
        reps_max: repsArr[1] || repsArr[0] || 12,
        rest_seconds: parseInt(ex.rest) || 60,
        order: i,
        // Phase 2.5 (from PR #6): persist the coach's per-exercise cue
        // (e.g. "RIR 2", "Hams-focused"). Routines created via the editor
        // don't set this.
        note: ex.note ?? null,
      });
      if (linkErr) throw linkErr;
    }));
  };

  const handleSaveRoutine = (workout: GeneratedWorkout) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    handleClose();
    toast.info(`Saving “${workout.name}”…`);
    insertRoutineToBackend(workout)
      .then(() => {
        toast.success('Routine saved');
        onRoutineCreated?.();
      })
      .catch(() => {
        toast.error(`Couldn't save “${workout.name}”`, {
          action: { label: 'Retry', onPress: () => handleSaveRoutine(workout) },
        });
      })
      .finally(() => {
        inFlightRef.current = false;
      });
  };

  const handleSaveRoutines = (workouts: GeneratedWorkout[]) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    handleClose();
    (async () => {
      // Track which item we're attempting so Retry resumes from the failure
      // point instead of replaying earlier items that already committed —
      // otherwise a failure on item N produces duplicates of 0..N-1 on retry.
      let attemptingIndex = 0;
      try {
        for (let i = 0; i < workouts.length; i++) {
          attemptingIndex = i;
          toast.info(`Saving “${workouts[i].name}” (${i + 1}/${workouts.length})…`);
          await insertRoutineToBackend(workouts[i]);
        }
        toast.success(workouts.length > 1 ? `Saved ${workouts.length} routines` : 'Routine saved');
        onRoutineCreated?.();
      } catch {
        const remaining = workouts.slice(attemptingIndex);
        // Refresh to surface whatever did save before the failure.
        if (attemptingIndex > 0) onRoutineCreated?.();
        toast.error("Couldn't save all routines", {
          action: { label: 'Retry', onPress: () => handleSaveRoutines(remaining) },
        });
      } finally {
        inFlightRef.current = false;
      }
    })();
  };

  return (
    <Portal>
      {visible && (
        /*
          Rendered in the app's own window via <Portal>, not RN's <Modal> (a
          separate Android Dialog window that edge-to-edge insets by the nav
          bar, leaving a gap below bottom sheets). Backdrop is a flex column
          pushing the sheet to the bottom; the top region is a separate
          Pressable for tap-to-close (menu/gate only). The sheet itself is a
          plain View so inner ScrollViews keep their pan gestures.
        */
      <View style={[s.backdrop, { backgroundColor: C.overlay }]}>
        <Pressable
          style={{ flex: 1 }}
          // Backdrop closes on menu OR while the gate owns the modal —
          // neither has user input that could be lost. Chat/plan/workout
          // screens keep the tap inert so accidental backdrop hits don't
          // throw away mid-conversation state.
          onPress={(screen === 'menu' || !accessAllowed) ? handleClose : undefined}
        />
        <Animated.View
          entering={SlideInDown.duration(350).easing(Easing.out(Easing.cubic))}
          exiting={SlideOutDown.duration(200)}
          style={[
            s.modalContainer,
            {
              backgroundColor: C.background,
              height: sheetHeight,
              marginBottom: sheetMarginBottom,
              // Flush to the screen bottom now (portal, not a nav-bar-inset
              // Modal window), so pad content past the gesture/nav bar.
              paddingBottom: insets.bottom,
            },
          ]}
        >
          {/*
            Gate first. When the user isn't paid/trialing the gate owns the
            entire modal body — including its own header — and the menu
            header + screen dispatch below are skipped. When the gate is
            cleared (paid/trialing), we fall through to the existing flow.
          */}
          {!accessAllowed ? (
            <CoachAccessGate
              access={access}
              loading={accessLoading}
              refresh={refreshAccess}
              supabase={supabase}
              onClose={handleClose}
              onRequestSignIn={hasClerkKey ? handleRequestSignIn : undefined}
            />
          ) : showPaywall ? (
            /* Upgrade path for trialing users — owns the modal body
               while open. Close returns to the menu; a successful purchase
               flips access.state to 'paid' and we drop back to the menu
               on the next render. */
            <Paywall
              supabase={supabase}
              onClose={() => setShowPaywall(false)}
              onPurchased={async () => {
                await refreshAccess();
                setShowPaywall(false);
              }}
            />
          ) : (
            <>
              {/* Close/handle for menu */}
              {screen === 'menu' && (
                <View style={s.menuHeader}>
                  <TouchableOpacity
                    onPress={handleClose}
                    style={[s.closeCircle, { backgroundColor: C.muted }]}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel="Close Coach Drona"
                  >
                    <Feather name="x" size={16} color={C.foreground} />
                  </TouchableOpacity>
                  <View style={s.menuHeaderTitle}>
                    <SparkleIcon size={16} color={C.accentText} />
                    <Text style={[s.menuHeaderText, { color: C.foreground }]}>Coach Drona</Text>
                  </View>
                  <View style={{ width: 32 }} />
                </View>
              )}

              {/* Upgrade affordance for trialing users. Sits between the
                  header and the option cards — non-intrusive, but visible
                  every time they open the menu so converting before the
                  trial ends feels natural. Hidden for 'paid' users (no
                  upgrade path) and for non-menu screens (avoid clutter
                  during chat/plan/workout sessions). */}
              {screen === 'menu' && access.state === 'trialing' && (
                <TouchableOpacity
                  onPress={() => setShowPaywall(true)}
                  style={[s.upgradeBanner, { backgroundColor: C.primarySubtle, borderColor: C.primaryBorder }]}
                  activeOpacity={0.85}
                >
                  <View style={s.upgradeBannerLeft}>
                    <Feather name="zap" size={14} color={C.accentText} />
                    <Text style={[s.upgradeBannerText, { color: C.foreground }]}>
                      {typeof access.daysLeft === 'number'
                        ? `Trial · ${Math.max(0, Math.ceil(access.daysLeft))} day${Math.ceil(access.daysLeft) === 1 ? '' : 's'} left`
                        : 'Trial active'}
                    </Text>
                  </View>
                  <View style={s.upgradeBannerRight}>
                    {/* Stay a calm "X days left" chip until the trial's final
                        week; only then push the explicit Upgrade CTA. */}
                    {typeof access.daysLeft === 'number' && access.daysLeft <= 7 && (
                      <Text style={[s.upgradeBannerCta, { color: C.accentText }]}>Upgrade</Text>
                    )}
                    <Feather
                      name="chevron-right"
                      size={14}
                      color={typeof access.daysLeft === 'number' && access.daysLeft <= 7 ? C.accentText : C.textMuted}
                    />
                  </View>
                </TouchableOpacity>
              )}

              {screen === 'menu' && <MenuScreen onNavigate={setScreen} />}
              {screen === 'chat' && (
                <ChatScreen
                  // In workout mode the back arrow closes the sheet (no menu
                  // detour mid-workout); otherwise it returns to the menu.
                  onBack={workoutContext ? handleClose : () => setScreen('menu')}
                  onSaveRoutine={(name) => handleSaveRoutine({ name, exercises: [] })}
                  initialPrompt={initialPrompt}
                  userId={user?.id ?? null}
                  workoutContext={workoutContext}
                />
              )}
              {screen === 'plan' && (
                <GeneratePlanScreen
                  onBack={() => setScreen('menu')}
                  onSaveRoutines={handleSaveRoutines}
                />
              )}
              {screen === 'workout' && (
                <GenerateWorkoutScreen
                  onBack={() => setScreen('menu')}
                  onSaveRoutine={handleSaveRoutine}
                />
              )}
            </>
          )}
        </Animated.View>
      </View>
      )}
    </Portal>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  modalContainer: {
    borderTopLeftRadius: Radius.xxl,
    borderTopRightRadius: Radius.xxl,
    // height is set dynamically by AICoachModal to react to the on-screen
    // keyboard (see kbHeight tracking there). Do NOT add a static height here.
    overflow: 'hidden',
  },

  // Menu header
  menuHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.md,
  },
  closeCircle: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  menuHeaderTitle: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
  },
  menuHeaderText: {
    fontSize: FontSize.lg, fontWeight: FontWeight.bold,
  },

  // Upgrade banner — appears between the menu header and the option cards
  // for trialing users only. Tapping opens the in-modal paywall.
  upgradeBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: Spacing.xl,
    marginTop: Spacing.sm,
    marginBottom: Spacing.md,
    paddingVertical: 10,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.lg,
    borderWidth: 1,
  },
  upgradeBannerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  upgradeBannerText: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
  },
  upgradeBannerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  upgradeBannerCta: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.bold,
  },

  // Menu content
  menuContent: {
    flex: 1,
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.xxxl,
  },
  menuCenter: {
    alignItems: 'center',
    marginBottom: Spacing.xxxl,
  },
  menuIconWrap: {
    width: 64, height: 64, borderRadius: 32,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: Spacing.lg,
  },
  menuTitle: {
    fontSize: FontSize.lg, fontWeight: FontWeight.bold,
    marginBottom: 4,
  },
  menuSub: {
    fontSize: FontSize.base,
  },

  // Option cards
  optionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.lg,
    borderRadius: Radius.xl,
    borderWidth: 1,
    marginBottom: 12,
  },
  optionIconWrap: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
  },
  optionTitle: {
    fontSize: FontSize.base, fontWeight: FontWeight.semibold,
    marginBottom: 2,
  },
  optionSub: {
    fontSize: FontSize.sm,
  },

  // Screen header
  screenHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
    borderBottomWidth: 1,
  },
  backBtn: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  newChatBtn: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    marginLeft: 'auto',
  },
  screenTitle: {
    fontSize: FontSize.lg, fontWeight: FontWeight.bold,
  },

  // Chat
  chatMessages: {
    padding: Spacing.xl,
    paddingBottom: 20,
    gap: 12,
  },
  chatBubble: {
    maxWidth: '85%',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderRadius: Radius.xl,
  },
  userBubble: {
    alignSelf: 'flex-end',
    borderBottomRightRadius: 4,
  },
  assistantBubble: {
    alignSelf: 'flex-start',
    borderBottomLeftRadius: 4,
    borderWidth: 1,
  },
  chatText: {
    fontSize: FontSize.base,
    lineHeight: 20,
  },
  thinkingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 20,
  },
  thinkingText: {
    fontSize: FontSize.sm,
    fontStyle: 'italic',
    letterSpacing: 0.2,
  },
  // Markdown rendering primitives
  mdList: {
    gap: 4,
  },
  mdBulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingLeft: 2,
  },
  mdBulletDot: {
    fontSize: FontSize.base,
    lineHeight: 20,
    fontWeight: FontWeight.bold,
    width: 10,
  },
  citationList: {
    marginTop: Spacing.md,
    paddingTop: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.08)',
    gap: 6,
  },
  citationHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 2,
  },
  citationHeaderText: {
    fontSize: 10,
    fontWeight: FontWeight.semibold,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  citationPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: Radius.md,
  },
  citationN: {
    fontSize: 11,
    fontWeight: FontWeight.bold,
    fontVariant: ['tabular-nums'],
    minWidth: 22,
  },
  citationTitle: {
    fontSize: 12,
    lineHeight: 15,
    fontWeight: FontWeight.semibold,
  },
  citationMeta: {
    fontSize: 10,
    marginTop: 1,
  },
  chatInputWrap: {
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
    borderTopWidth: 1,
  },
  chatInputBox: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    borderWidth: 1,
    borderRadius: Radius.xl,
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
  },
  chatInput: {
    flex: 1,
    fontSize: FontSize.base,
    maxHeight: 100,
    paddingVertical: 6,
  },
  sendBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
  },

  // In-workout quick-question chips (above the input, workout mode only)
  suggestionScroll: {
    flexGrow: 0,
  },
  suggestionRow: {
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.sm,
    gap: 8,
    alignItems: 'center',
  },
  suggestionChip: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: Radius.full,
    borderWidth: 1,
  },
  suggestionChipText: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.semibold,
  },

  // Forms
  formContent: {
    padding: Spacing.xl,
    paddingBottom: 40,
    gap: 20,
  },
  formField: {
    gap: 8,
  },
  formLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  formLabel: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.medium,
  },
  formInput: {
    height: 48,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.lg,
    fontSize: FontSize.base,
    borderWidth: 1,
  },
  formRow: {
    flexDirection: 'row',
    gap: 12,
  },
  quickPicks: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 4,
  },
  quickPick: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: Radius.full,
    borderWidth: 1,
  },
  quickPickText: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.medium,
  },

  // Level buttons
  levelRow: {
    flexDirection: 'row',
    borderRadius: Radius.lg,
    overflow: 'hidden',
    borderWidth: 1,
  },
  levelBtn: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    borderRightWidth: 1,
  },
  levelBtnText: {
    fontSize: FontSize.base,
  },

  // Dropdown
  dropdownBtn: {
    height: 48,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
  },
  dropdownText: {
    fontSize: FontSize.base,
  },
  dropdownList: {
    position: 'absolute',
    top: 52,
    left: 0,
    right: 0,
    borderRadius: Radius.lg,
    borderWidth: 1,
    zIndex: 100,
    overflow: 'hidden',
  },
  dropdownItem: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  dropdownItemText: {
    fontSize: FontSize.base,
  },

  // Primary button
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 52,
    borderRadius: Radius.xl,
    backgroundColor: Colors.primary,
  },
  primaryBtnText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
    color: Colors.primaryFg,
  },

  // Secondary button
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 48,
    borderRadius: Radius.xl,
  },
  secondaryBtnText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.medium,
  },

  // Result cards
  resultCard: {
    borderRadius: Radius.xl,
    borderWidth: 1,
    padding: Spacing.lg,
  },
  resultCardTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    marginBottom: 2,
  },
  resultCardSub: {
    fontSize: FontSize.sm,
    marginBottom: Spacing.md,
  },
  resultExRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderTopWidth: 1,
  },
  resultExName: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.medium,
  },
  resultExDetail: {
    fontSize: FontSize.sm,
  },
  resultActions: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
    paddingBottom: 40,
    borderTopWidth: 1,
  },

  // ── Phase 2.5: generated card extras (rationale callout, exercise notes,
  //              refine chat strip, loading + error states) ────────────────
  resultCardFocus: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.medium,
    marginBottom: 2,
  },
  resultExRowOuter: {
    paddingVertical: 10,
    borderTopWidth: 1,
    gap: 4,
  },
  resultExRowTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  resultExNote: {
    fontSize: FontSize.xs,
    fontStyle: 'italic',
    lineHeight: 14,
  },
  rationaleCallout: {
    marginTop: Spacing.xs,
    marginBottom: Spacing.sm,
    padding: Spacing.md,
    borderRadius: Radius.md,
    borderWidth: 1,
    gap: 6,
  },
  rationaleHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  rationaleHeaderText: {
    fontSize: 10,
    fontWeight: FontWeight.bold,
    letterSpacing: 0.8,
  },
  rationaleText: {
    fontSize: FontSize.sm,
    lineHeight: 18,
  },
  workoutNoteCaption: {
    fontSize: FontSize.xs,
    fontStyle: 'italic',
    marginBottom: 4,
  },
  planMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
    marginBottom: Spacing.sm,
  },
  planMetaText: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.medium,
  },
  refineWrap: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.md,
    paddingBottom: 30,
    borderTopWidth: 1,
    gap: 10,
  },
  refineInputBox: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    borderWidth: 1,
    borderRadius: Radius.xl,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  refineInput: {
    flex: 1,
    fontSize: FontSize.sm,
    maxHeight: 80,
    paddingVertical: 6,
  },
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.xl,
    gap: Spacing.md,
  },
  loadingHeader: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
  },
  loadingIntent: {
    fontSize: FontSize.sm,
    textAlign: 'center',
    fontStyle: 'italic',
    maxWidth: 280,
    lineHeight: 18,
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    padding: 10,
    borderRadius: Radius.md,
  },
  errorBannerText: {
    fontSize: FontSize.sm,
    flex: 1,
  },
});
