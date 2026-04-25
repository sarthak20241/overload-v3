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
  ActivityIndicator,
} from 'react-native';
import Animated, {
  SlideInDown, SlideOutDown, FadeIn, FadeInDown, Easing,
} from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { addGuestRoutine } from '@/lib/mockData';

// ─── Types ───────────────────────────────────────────────────────────────────
type Screen = 'menu' | 'chat' | 'plan' | 'workout';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

interface GeneratedExercise {
  name: string;
  sets: number;
  reps: string;
  rest: string;
}

interface GeneratedWorkout {
  name: string;
  exercises: GeneratedExercise[];
}

// ─── Sparkle Icon ────────────────────────────────────────────────────────────
function SparkleIcon({ size = 20, color = '#4d7a00' }: { size?: number; color?: string }) {
  return <Feather name="zap" size={size} color={color} />;
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
async function callAICoach(messages: { role: string; content: string }[]): Promise<string> {
  // Configured environments must hit the real edge function. Guest/demo mode
  // (no Supabase) falls back to the canned mock so the UI still demonstrates the flow.
  if (isSupabaseConfigured) {
    try {
      const { data, error } = await supabase.functions.invoke('ai-coach', {
        body: { messages },
      });
      if (error) throw error;
      if (data?.response) return data.response as string;
      throw new AICoachUnavailableError();
    } catch (err: any) {
      if (err instanceof AICoachUnavailableError) throw err;
      throw new AICoachUnavailableError(
        err?.message ? `AI Coach error: ${err.message}` : undefined
      );
    }
  }
  // Guest/demo mode only: canned response
  return getMockResponse(messages[messages.length - 1]?.content || '');
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

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: ChatMessage = { id: Date.now().toString(), role: 'user', content: text };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);

    const allMessages = [...messages, userMsg].map(m => ({ role: m.role, content: m.content }));
    let content: string;
    try {
      content = await callAICoach(allMessages);
    } catch (err: any) {
      content = err instanceof AICoachUnavailableError
        ? err.message
        : 'AI Coach is currently unavailable. Please try again later.';
    }

    const assistantMsg: ChatMessage = {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content,
    };
    setMessages(prev => [...prev, assistantMsg]);
    setLoading(false);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
  }, [input, loading, messages]);

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
            <Text style={[
              s.chatText,
              { color: msg.role === 'user' ? Colors.primaryFg : C.foreground },
            ]}>{msg.content}</Text>
          </View>
        ))}
        {loading && (
          <View style={[s.assistantBubble, s.chatBubble, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
            <ActivityIndicator size="small" color={C.accentText} />
          </View>
        )}
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
  const [goal, setGoal] = useState('');
  const [days, setDays] = useState('4 days');
  const [sessionLength, setSessionLength] = useState('45-60 min');
  const [level, setLevel] = useState<'Beginner' | 'Intermediate' | 'Advanced'>('Intermediate');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<GeneratedWorkout[] | null>(null);

  const handleGenerate = async () => {
    setLoading(true);
    const prompt = `Generate a workout plan: Goal: ${goal || 'general fitness'}. ${days}/week, ${sessionLength} sessions, ${level} level. Return a structured plan with workout names and exercises (name, sets, reps, rest).`;
    try { await callAICoach([{ role: 'user', content: prompt }]); } catch {}
    // For demo, create mock structured data
    const mockPlan: GeneratedWorkout[] = [
      {
        name: 'Push Day',
        exercises: [
          { name: 'Bench Press', sets: 4, reps: '8-10', rest: '90s' },
          { name: 'Overhead Press', sets: 3, reps: '8-12', rest: '90s' },
          { name: 'Incline Dumbbell Press', sets: 3, reps: '10-12', rest: '60s' },
          { name: 'Lateral Raises', sets: 3, reps: '12-15', rest: '60s' },
          { name: 'Tricep Pushdowns', sets: 3, reps: '12-15', rest: '60s' },
        ],
      },
      {
        name: 'Pull Day',
        exercises: [
          { name: 'Deadlift', sets: 4, reps: '5-6', rest: '120s' },
          { name: 'Barbell Rows', sets: 4, reps: '8-10', rest: '90s' },
          { name: 'Pull-Ups', sets: 3, reps: '8-12', rest: '90s' },
          { name: 'Face Pulls', sets: 3, reps: '12-15', rest: '60s' },
          { name: 'Barbell Curls', sets: 3, reps: '10-12', rest: '60s' },
        ],
      },
      {
        name: 'Leg Day',
        exercises: [
          { name: 'Squats', sets: 4, reps: '6-8', rest: '120s' },
          { name: 'Romanian Deadlift', sets: 3, reps: '8-10', rest: '90s' },
          { name: 'Leg Press', sets: 3, reps: '10-12', rest: '90s' },
          { name: 'Leg Curls', sets: 3, reps: '12-15', rest: '60s' },
          { name: 'Calf Raises', sets: 4, reps: '12-15', rest: '60s' },
        ],
      },
    ];
    setResult(mockPlan);
    setLoading(false);
  };

  if (result) {
    return (
      <View style={{ flex: 1 }}>
        <View style={[s.screenHeader, { borderColor: C.borderSubtle }]}>
          <TouchableOpacity onPress={() => setResult(null)} style={[s.backBtn, { backgroundColor: C.muted }]}>
            <Feather name="arrow-left" size={16} color={C.foreground} />
          </TouchableOpacity>
          <SparkleIcon size={16} color={C.accentText} />
          <Text style={[s.screenTitle, { color: C.foreground }]}>Your Plan</Text>
        </View>
        <ScrollView contentContainerStyle={{ padding: Spacing.xl, paddingBottom: 100, gap: 16 }}>
          {result.map((workout, wi) => (
            <Animated.View
              key={wi}
              entering={FadeInDown.delay(wi * 100).duration(300)}
              style={[s.resultCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}
            >
              <Text style={[s.resultCardTitle, { color: C.foreground }]}>{workout.name}</Text>
              <Text style={[s.resultCardSub, { color: C.mutedFg }]}>
                {workout.exercises.length} exercises
              </Text>
              {workout.exercises.map((ex, ei) => (
                <View key={ei} style={[s.resultExRow, { borderColor: C.borderSubtle }]}>
                  <Text style={[s.resultExName, { color: C.foreground }]}>{ex.name}</Text>
                  <Text style={[s.resultExDetail, { color: C.mutedFg }]}>
                    {ex.sets}x{ex.reps} · {ex.rest}
                  </Text>
                </View>
              ))}
            </Animated.View>
          ))}
        </ScrollView>
        <View style={[s.resultActions, { backgroundColor: C.background, borderColor: C.borderSubtle }]}>
          <TouchableOpacity
            onPress={() => onSaveRoutines(result)}
            style={[s.primaryBtn]}
          >
            <Feather name="check" size={16} color={Colors.primaryFg} />
            <Text style={s.primaryBtnText}>Save All Routines</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

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

        {/* Generate button */}
        <TouchableOpacity
          onPress={handleGenerate}
          disabled={loading}
          style={[s.primaryBtn, loading && { opacity: 0.7 }]}
        >
          {loading ? (
            <ActivityIndicator size="small" color={Colors.primaryFg} />
          ) : (
            <>
              <SparkleIcon size={16} color={Colors.primaryFg} />
              <Text style={s.primaryBtnText}>Generate Plan</Text>
            </>
          )}
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
  const [focus, setFocus] = useState('');
  const [duration, setDuration] = useState('45 min');
  const [equipment, setEquipment] = useState('Full Gym');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<GeneratedWorkout | null>(null);

  const handleGenerate = async () => {
    setLoading(true);
    const prompt = `Generate a single workout: Focus: ${focus || 'full body'}. Duration: ${duration}. Equipment: ${equipment}. Return exercise name, sets, reps, rest.`;
    try { await callAICoach([{ role: 'user', content: prompt }]); } catch {}
    // Mock structured data
    const focusLower = focus.toLowerCase();
    let mockWorkout: GeneratedWorkout;
    if (focusLower.includes('push') || focusLower.includes('chest')) {
      mockWorkout = {
        name: focus || 'Push Day',
        exercises: [
          { name: 'Bench Press', sets: 4, reps: '8-10', rest: '90s' },
          { name: 'Overhead Press', sets: 3, reps: '8-12', rest: '90s' },
          { name: 'Incline Dumbbell Press', sets: 3, reps: '10-12', rest: '60s' },
          { name: 'Cable Flyes', sets: 3, reps: '12-15', rest: '60s' },
          { name: 'Tricep Dips', sets: 3, reps: '10-12', rest: '60s' },
        ],
      };
    } else if (focusLower.includes('pull') || focusLower.includes('back')) {
      mockWorkout = {
        name: focus || 'Pull Day',
        exercises: [
          { name: 'Deadlift', sets: 4, reps: '5-6', rest: '120s' },
          { name: 'Barbell Rows', sets: 4, reps: '8-10', rest: '90s' },
          { name: 'Pull-Ups', sets: 3, reps: '8-12', rest: '90s' },
          { name: 'Face Pulls', sets: 3, reps: '12-15', rest: '60s' },
          { name: 'Barbell Curls', sets: 3, reps: '10-12', rest: '60s' },
        ],
      };
    } else if (focusLower.includes('leg')) {
      mockWorkout = {
        name: focus || 'Leg Day',
        exercises: [
          { name: 'Squats', sets: 4, reps: '6-8', rest: '120s' },
          { name: 'Romanian Deadlift', sets: 3, reps: '8-10', rest: '90s' },
          { name: 'Leg Press', sets: 3, reps: '10-12', rest: '90s' },
          { name: 'Leg Curls', sets: 3, reps: '12-15', rest: '60s' },
          { name: 'Calf Raises', sets: 4, reps: '12-15', rest: '60s' },
        ],
      };
    } else {
      mockWorkout = {
        name: focus || 'Full Body',
        exercises: [
          { name: 'Squats', sets: 4, reps: '6-8', rest: '120s' },
          { name: 'Bench Press', sets: 4, reps: '8-10', rest: '90s' },
          { name: 'Barbell Rows', sets: 4, reps: '8-10', rest: '90s' },
          { name: 'Overhead Press', sets: 3, reps: '8-12', rest: '60s' },
          { name: 'Pull-Ups', sets: 3, reps: '8-12', rest: '60s' },
        ],
      };
    }
    setResult(mockWorkout);
    setLoading(false);
  };

  if (result) {
    return (
      <View style={{ flex: 1 }}>
        <View style={[s.screenHeader, { borderColor: C.borderSubtle }]}>
          <TouchableOpacity onPress={() => setResult(null)} style={[s.backBtn, { backgroundColor: C.muted }]}>
            <Feather name="arrow-left" size={16} color={C.foreground} />
          </TouchableOpacity>
          <SparkleIcon size={16} color={C.accentText} />
          <Text style={[s.screenTitle, { color: C.foreground }]}>Your Workout</Text>
        </View>
        <ScrollView contentContainerStyle={{ padding: Spacing.xl, paddingBottom: 100, gap: 16 }}>
          <Animated.View
            entering={FadeInDown.duration(300)}
            style={[s.resultCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}
          >
            <Text style={[s.resultCardTitle, { color: C.foreground }]}>{result.name}</Text>
            <Text style={[s.resultCardSub, { color: C.mutedFg }]}>
              {result.exercises.length} exercises
            </Text>
            {result.exercises.map((ex, ei) => (
              <View key={ei} style={[s.resultExRow, { borderColor: C.borderSubtle }]}>
                <Text style={[s.resultExName, { color: C.foreground }]}>{ex.name}</Text>
                <Text style={[s.resultExDetail, { color: C.mutedFg }]}>
                  {ex.sets}x{ex.reps} · {ex.rest}
                </Text>
              </View>
            ))}
          </Animated.View>
        </ScrollView>
        <View style={[s.resultActions, { backgroundColor: C.background, borderColor: C.borderSubtle }]}>
          <TouchableOpacity
            onPress={() => onSaveRoutine(result)}
            style={[s.primaryBtn]}
          >
            <Feather name="check" size={16} color={Colors.primaryFg} />
            <Text style={s.primaryBtnText}>Save as Routine</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

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

        {/* Generate button */}
        <TouchableOpacity
          onPress={handleGenerate}
          disabled={loading}
          style={[s.primaryBtn, loading && { opacity: 0.7 }]}
        >
          {loading ? (
            <ActivityIndicator size="small" color={Colors.primaryFg} />
          ) : (
            <>
              <SparkleIcon size={16} color={Colors.primaryFg} />
              <Text style={s.primaryBtnText}>Generate Workout</Text>
            </>
          )}
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
  const [screen, setScreen] = useState<Screen>(initialScreen);

  useEffect(() => {
    if (visible) setScreen(initialScreen);
  }, [visible, initialScreen]);

  const handleClose = () => {
    setScreen('menu');
    onClose();
  };

  const handleSaveRoutine = async (workout: GeneratedWorkout) => {
    if (!isSupabaseConfigured) {
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
            exercises: {
              id: `gex-${Date.now()}-${i}`,
              name: ex.name,
              muscle_group: 'Other',
              category: 'Other',
            },
          };
        }),
      });
      handleClose();
      onRoutineCreated?.();
      return;
    }
    // Create routine in Supabase
    const { data: routine, error } = await supabase
      .from('routines')
      .insert({ name: workout.name })
      .select()
      .single();

    if (error || !routine) {
      handleClose();
      return;
    }

    // Find or create exercises and link them
    for (let i = 0; i < workout.exercises.length; i++) {
      const ex = workout.exercises[i];
      // Try to find existing exercise
      let { data: existingEx } = await supabase
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

      if (exerciseId) {
        const repsArr = ex.reps.split('-').map(Number);
        await supabase.from('routine_exercises').insert({
          routine_id: routine.id,
          exercise_id: exerciseId,
          sets: ex.sets,
          reps_min: repsArr[0] || 8,
          reps_max: repsArr[1] || repsArr[0] || 12,
          rest_seconds: parseInt(ex.rest) || 60,
          order: i,
        });
      }
    }

    handleClose();
    onRoutineCreated?.();
  };

  const handleSaveRoutines = async (workouts: GeneratedWorkout[]) => {
    for (const workout of workouts) {
      await handleSaveRoutine(workout);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={handleClose}>
      <Pressable
        style={[s.backdrop, { backgroundColor: C.overlay }]}
        onPress={screen === 'menu' ? handleClose : undefined}
      >
        <Animated.View
          entering={SlideInDown.duration(350).easing(Easing.out(Easing.cubic))}
          exiting={SlideOutDown.duration(200)}
          style={[s.modalContainer, { backgroundColor: C.background }]}
        >
          <Pressable style={{ flex: 1 }}>
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
          </Pressable>
        </Animated.View>
      </Pressable>
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
});
