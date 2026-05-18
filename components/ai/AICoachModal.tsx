/**
 * AI Coach Modal — full-screen bottom sheet with 3 options:
 * 1. Chat with AI Coach
 * 2. Generate Workout Plan
 * 3. Generate a Workout
 * Matches Figma design exactly.
 */
import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, Pressable,
  TextInput, ScrollView, FlatList, KeyboardAvoidingView, Platform,
  ActivityIndicator, Linking,
} from 'react-native';
import Animated, {
  SlideInDown, SlideOutDown, FadeIn, FadeInDown, Easing,
} from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { useClerkUser, hasClerkKey } from '@/hooks/useClerkUser';
import { isSupabaseConfigured, useSupabaseClient } from '@/lib/supabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import { addGuestRoutine } from '@/lib/mockData';
import { useToast } from '@/components/ui/Toast';

// ─── Types ───────────────────────────────────────────────────────────────────
type Screen = 'menu' | 'chat' | 'plan' | 'workout';

interface Citation {
  n: number;             // the [N] marker in the response text
  id: string;            // research_kb row id
  title: string;
  authors: string[];
  year?: number;
  url?: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  // While the assistant placeholder is waiting on first token, we show this
  // text instead of a bare spinner. Server `status` events update it as the
  // model moves through phases (initial think → tool calls → drafting).
  thinkingPhase?: string;
}

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
  content,
  citations,
  textColor,
}: { content: string; citations?: Citation[]; textColor: string }) {
  const { C } = useTheme();
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
  constructor(message = 'AI Coach is currently unavailable. Please try again later.') {
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
        throw new AICoachUnavailableError(`AI Coach error: ${detail}`);
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
        err?.message ? `AI Coach error: ${err.message}` : undefined
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
}

interface StreamingOptions {
  // When set, forces tool_choice on that tool — used for Generate Workout /
  // Generate Plan flows so output is guaranteed structured.
  forceTool?: 'generate_workout' | 'generate_plan';
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
  return "Great question! As your AI coach, I can help with workout programming, nutrition advice, recovery tips, and tracking your progress. What specific area would you like to focus on?";
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
    { screen: 'chat', icon: 'message-circle', title: 'Chat with AI Coach', sub: 'Talk progress, PRs, plateaus, or anything on your mind' },
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
        <Text style={[s.menuSub, { color: C.mutedFg }]}>Your AI-powered fitness assistant</Text>
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
function ChatScreen({ onBack, onSaveRoutine }: { onBack: () => void; onSaveRoutine: (name: string) => void }) {
  const { C } = useTheme();
  const supabase = useSupabaseClient();
  // Clerk getToken \u2014 used directly to authenticate the streaming SSE fetch.
  // Falls back to null in guest mode (no Clerk key).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const clerkAuth = hasClerkKey ? require('@clerk/clerk-expo').useAuth() : null;
  const getToken: (() => Promise<string | null>) | null = clerkAuth?.getToken ?? null;
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: '1',
      role: 'assistant',
      content: "Hey there! \u{1F4AA} I'm your AI Coach. Ask me anything about training, nutrition, recovery \u2014 or say \"create a workout\" and I'll build one for you right here!",
    },
  ]);
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

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

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

    const allMessages = [...messages, userMsg].map(m => ({ role: m.role, content: m.content }));

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
          : 'AI Coach is currently unavailable. Please try again later.';
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
        typewriter.fail(`AI Coach error: ${errStr}`);
        setLoading(false);
        streamRef.current = null;
      },
    });
  }, [input, loading, messages, supabase, getToken]);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
      keyboardVerticalOffset={0}
    >
      {/* Header */}
      <View style={[s.screenHeader, { borderColor: C.borderSubtle }]}>
        <TouchableOpacity onPress={onBack} style={[s.backBtn, { backgroundColor: C.muted }]}>
          <Feather name="arrow-left" size={16} color={C.foreground} />
        </TouchableOpacity>
        <SparkleIcon size={16} color={C.accentText} />
        <Text style={[s.screenTitle, { color: C.foreground }]}>Chat with Coach</Text>
      </View>

      {/* Messages */}
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={s.chatMessages}
        showsVerticalScrollIndicator={false}
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

      {/* Input */}
      <View style={[s.chatInputWrap, { backgroundColor: C.background, borderColor: C.borderSubtle }]}>
        <View style={[s.chatInputBox, { backgroundColor: C.inputBg, borderColor: C.border }]}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder="Ask your coach anything..."
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
    </KeyboardAvoidingView>
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
  onChatWithCoach,
  onSaveRoutines,
}: {
  onBack: () => void;
  onChatWithCoach: () => void;
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
  const [refining, setRefining] = useState(false);
  const [coachIntent, setCoachIntent] = useState('');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [result, setResult] = useState<GeneratedPlan | null>(null);
  const [refineInput, setRefineInput] = useState('');
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
                { name: 'Incline DB Press', sets: 3, reps: '8-12', rest: '90s', note: 'Hams of the chest — push hard' },
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

  const handleRefine = async () => {
    const text = refineInput.trim();
    if (!text || refining || loading) return;
    setRefineInput('');
    const next = [...conversationRef.current, { role: 'user', content: text }];
    conversationRef.current = next;
    await runGeneration(next, true);
  };

  // ── Result view ─────────────────────────────────────────────────────────
  if (result) {
    return (
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <View style={[s.screenHeader, { borderColor: C.borderSubtle }]}>
          <TouchableOpacity
            onPress={() => { setResult(null); conversationRef.current = []; }}
            style={[s.backBtn, { backgroundColor: C.muted }]}
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

        <View style={[s.refineWrap, { backgroundColor: C.background, borderColor: C.borderSubtle }]}>
          <View style={[s.refineInputBox, { backgroundColor: C.inputBg, borderColor: C.border }]}>
            <Feather name="message-circle" size={14} color={C.textMuted} style={{ marginLeft: 4, marginBottom: 10 }} />
            <TextInput
              value={refineInput}
              onChangeText={setRefineInput}
              placeholder={refining ? 'Refining…' : 'Refine: e.g. "drop to 3 days" or "more pulling"'}
              placeholderTextColor={C.textMuted}
              style={[s.refineInput, { color: C.foreground }]}
              multiline
              maxLength={300}
              editable={!refining}
              onSubmitEditing={handleRefine}
              blurOnSubmit
            />
            <TouchableOpacity
              onPress={handleRefine}
              disabled={!refineInput.trim() || refining}
              style={[
                s.sendBtn,
                {
                  backgroundColor: refineInput.trim() && !refining ? Colors.primary : C.muted,
                  marginBottom: 2,
                },
              ]}
            >
              {refining ? (
                <ActivityIndicator size="small" color={C.textMuted} />
              ) : (
                <Feather name="send" size={14} color={refineInput.trim() ? Colors.primaryFg : C.textMuted} />
              )}
            </TouchableOpacity>
          </View>
          <TouchableOpacity
            onPress={() => onSaveRoutines(result.workouts)}
            disabled={refining}
            style={[s.primaryBtn, refining && { opacity: 0.6 }]}
          >
            <Feather name="check" size={16} color={Colors.primaryFg} />
            <Text style={s.primaryBtnText}>Save All Routines</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    );
  }

  // ── Loading state (first generation only — refinement shows over the card)
  if (loading) {
    return (
      <View style={{ flex: 1 }}>
        <View style={[s.screenHeader, { borderColor: C.borderSubtle }]}>
          <TouchableOpacity onPress={onBack} style={[s.backBtn, { backgroundColor: C.muted }]}>
            <Feather name="arrow-left" size={16} color={C.foreground} />
          </TouchableOpacity>
          <SparkleIcon size={16} color={C.accentText} />
          <Text style={[s.screenTitle, { color: C.foreground }]}>Generating…</Text>
        </View>
        <View style={s.loadingWrap}>
          <ActivityIndicator size="small" color={C.accentText} />
          <Text style={[s.loadingHeader, { color: C.foreground }]}>Coach is designing your plan</Text>
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
        <TouchableOpacity onPress={onBack} style={[s.backBtn, { backgroundColor: C.muted }]}>
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

        {/* Chat alternative */}
        <TouchableOpacity
          onPress={onChatWithCoach}
          style={[s.secondaryBtn, { backgroundColor: C.muted }]}
        >
          <Feather name="message-circle" size={14} color={C.mutedFg} />
          <Text style={[s.secondaryBtnText, { color: C.mutedFg }]}>Or chat with coach to refine</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

// ─── Generate Workout Screen ─────────────────────────────────────────────────
function GenerateWorkoutScreen({
  onBack,
  onChatWithCoach,
  onSaveRoutine,
}: {
  onBack: () => void;
  onChatWithCoach: () => void;
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
  const [refining, setRefining] = useState(false);
  const [coachIntent, setCoachIntent] = useState('');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [result, setResult] = useState<GeneratedWorkout | null>(null);
  const [refineInput, setRefineInput] = useState('');
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

  const handleRefine = async () => {
    const text = refineInput.trim();
    if (!text || refining || loading) return;
    setRefineInput('');
    const next = [...conversationRef.current, { role: 'user', content: text }];
    conversationRef.current = next;
    await runGeneration(next, true);
  };

  // ── Result view ─────────────────────────────────────────────────────────
  if (result) {
    return (
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <View style={[s.screenHeader, { borderColor: C.borderSubtle }]}>
          <TouchableOpacity
            onPress={() => { setResult(null); conversationRef.current = []; }}
            style={[s.backBtn, { backgroundColor: C.muted }]}
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

        <View style={[s.refineWrap, { backgroundColor: C.background, borderColor: C.borderSubtle }]}>
          <View style={[s.refineInputBox, { backgroundColor: C.inputBg, borderColor: C.border }]}>
            <Feather name="message-circle" size={14} color={C.textMuted} style={{ marginLeft: 4, marginBottom: 10 }} />
            <TextInput
              value={refineInput}
              onChangeText={setRefineInput}
              placeholder={refining ? 'Refining…' : 'Refine: e.g. "swap squat for hack squat" or "shorter"'}
              placeholderTextColor={C.textMuted}
              style={[s.refineInput, { color: C.foreground }]}
              multiline
              maxLength={300}
              editable={!refining}
              onSubmitEditing={handleRefine}
              blurOnSubmit
            />
            <TouchableOpacity
              onPress={handleRefine}
              disabled={!refineInput.trim() || refining}
              style={[
                s.sendBtn,
                {
                  backgroundColor: refineInput.trim() && !refining ? Colors.primary : C.muted,
                  marginBottom: 2,
                },
              ]}
            >
              {refining ? (
                <ActivityIndicator size="small" color={C.textMuted} />
              ) : (
                <Feather name="send" size={14} color={refineInput.trim() ? Colors.primaryFg : C.textMuted} />
              )}
            </TouchableOpacity>
          </View>
          <TouchableOpacity
            onPress={() => onSaveRoutine(result)}
            disabled={refining}
            style={[s.primaryBtn, refining && { opacity: 0.6 }]}
          >
            <Feather name="check" size={16} color={Colors.primaryFg} />
            <Text style={s.primaryBtnText}>Save as Routine</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    );
  }

  // ── Loading state ───────────────────────────────────────────────────────
  if (loading) {
    return (
      <View style={{ flex: 1 }}>
        <View style={[s.screenHeader, { borderColor: C.borderSubtle }]}>
          <TouchableOpacity onPress={onBack} style={[s.backBtn, { backgroundColor: C.muted }]}>
            <Feather name="arrow-left" size={16} color={C.foreground} />
          </TouchableOpacity>
          <SparkleIcon size={16} color={C.accentText} />
          <Text style={[s.screenTitle, { color: C.foreground }]}>Generating…</Text>
        </View>
        <View style={s.loadingWrap}>
          <ActivityIndicator size="small" color={C.accentText} />
          <Text style={[s.loadingHeader, { color: C.foreground }]}>Coach is designing your workout</Text>
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
        <TouchableOpacity onPress={onBack} style={[s.backBtn, { backgroundColor: C.muted }]}>
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

        {/* Chat alternative */}
        <TouchableOpacity
          onPress={onChatWithCoach}
          style={[s.secondaryBtn, { backgroundColor: C.muted }]}
        >
          <Feather name="message-circle" size={14} color={C.mutedFg} />
          <Text style={[s.secondaryBtnText, { color: C.mutedFg }]}>Or chat with coach first</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

// ─── Main Modal ──────────────────────────────────────────────────────────────
export function AICoachModal({
  visible,
  onClose,
  onRoutineCreated,
  initialScreen = 'menu',
}: {
  visible: boolean;
  onClose: () => void;
  onRoutineCreated?: () => void;
  initialScreen?: Screen;
}) {
  const { C } = useTheme();
  const { user } = useClerkUser();
  const supabase = useSupabaseClient();
  const toast = useToast();
  const [screen, setScreen] = useState<Screen>(initialScreen);
  // Sub-frame double-tap guard — modal closes immediately on save, so the
  // visible-button block goes away fast, but the close animation leaves a tiny
  // window where a second tap could fire before React re-renders.
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (visible) setScreen(initialScreen);
  }, [visible, initialScreen]);

  const handleClose = () => {
    setScreen('menu');
    onClose();
  };

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
      const { data: existingEx } = await supabase
        .from('exercises')
        .select('id')
        .eq('name', ex.name)
        .single();

      let exerciseId = existingEx?.id;
      if (!exerciseId) {
        const { data: newEx } = await supabase
          .from('exercises')
          .insert({ name: ex.name, muscle_group: 'Other', category: 'Other' })
          .select('id')
          .single();
        exerciseId = newEx?.id;
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
    <Modal visible={visible} transparent animationType="none" onRequestClose={handleClose}>
      {/*
        Backdrop layout: a flex column that pushes the modal sheet to the
        bottom. The top ~8% is a separate Pressable that handles the
        "tap-to-close" affordance (menu screen only). The modal sheet itself
        is a plain View — NOTHING wraps the screen content, so ScrollViews
        inside (chat history, workout/plan result) receive pan gestures
        without an outer Pressable competing for the touch responder.
        (Previously a `<Pressable style={{flex:1}}>` wrapped the screens to
        block taps from bubbling to the backdrop Pressable, but that's what
        was eating scroll-from-the-middle gestures.)
      */}
      <View style={[s.backdrop, { backgroundColor: C.overlay }]}>
        <Pressable
          style={{ flex: 1 }}
          onPress={screen === 'menu' ? handleClose : undefined}
        />
        <Animated.View
          entering={SlideInDown.duration(350).easing(Easing.out(Easing.cubic))}
          exiting={SlideOutDown.duration(200)}
          style={[s.modalContainer, { backgroundColor: C.background }]}
        >
          {/* Close/handle for menu */}
          {screen === 'menu' && (
            <View style={s.menuHeader}>
              <TouchableOpacity
                onPress={handleClose}
                style={[s.closeCircle, { backgroundColor: C.muted }]}
              >
                <Feather name="x" size={16} color={C.foreground} />
              </TouchableOpacity>
              <View style={s.menuHeaderTitle}>
                <SparkleIcon size={16} color={C.accentText} />
                <Text style={[s.menuHeaderText, { color: C.foreground }]}>AI Coach</Text>
              </View>
              <View style={{ width: 32 }} />
            </View>
          )}

          {screen === 'menu' && <MenuScreen onNavigate={setScreen} />}
          {screen === 'chat' && (
            <ChatScreen
              onBack={() => setScreen('menu')}
              onSaveRoutine={(name) => handleSaveRoutine({ name, exercises: [] })}
            />
          )}
          {screen === 'plan' && (
            <GeneratePlanScreen
              onBack={() => setScreen('menu')}
              onChatWithCoach={() => setScreen('chat')}
              onSaveRoutines={handleSaveRoutines}
            />
          )}
          {screen === 'workout' && (
            <GenerateWorkoutScreen
              onBack={() => setScreen('menu')}
              onChatWithCoach={() => setScreen('chat')}
              onSaveRoutine={handleSaveRoutine}
            />
          )}
        </Animated.View>
      </View>
    </Modal>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  modalContainer: {
    borderTopLeftRadius: Radius.xxl,
    borderTopRightRadius: Radius.xxl,
    height: '92%',
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
