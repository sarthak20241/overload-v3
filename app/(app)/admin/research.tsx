/**
 * Research-KB Review Dashboard (admin only).
 *
 * Phase 3 UI for the human-in-the-loop step of the ingestion pipeline.
 * Cron writes papers into research_kb_pending each night; an admin reviews
 * them here and either promotes into research_kb (live retrieval table)
 * or rejects with a reason.
 *
 * Server-side guarantees:
 *   - RLS on research_kb_pending allows SELECT only to admin_users members
 *   - The promote_pending_to_kb / reject_pending RPCs re-check is_admin()
 *     before mutating
 *
 * Non-admins who deep-link here get a polite "no access" screen.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator, BackHandler, Pressable, TextInput,
  Keyboard, Platform, Linking, RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import Animated, {
  FadeInDown, SlideInDown, SlideOutDown, Easing,
} from 'react-native-reanimated';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { useSupabaseClient } from '@/lib/supabase';
import { useAdminCheck } from '@/hooks/useAdminCheck';
import { Portal } from '@/components/ui/Portal';

// ─── Types ──────────────────────────────────────────────────────────────────
// Phase 3 contradiction detection. Set on pending rows by the ingest worker
// when a new paper's key_finding conflicts with an existing kb entry (or
// describes different conditions). The dashboard surfaces them side-by-side
// in the detail sheet so the reviewer sees the disagreement before they
// hit Approve.
interface ContradictionFlag {
  kb_id: string;
  kb_title: string;
  kb_finding: string;
  kb_study_design: string;
  kb_trust_score: number;
  similarity: number;
  verdict: 'contradict' | 'agree' | 'different_conditions' | 'unrelated';
  confidence: number;
  rationale: string;
}

interface PendingPaper {
  id: string;
  source: string;
  url: string;
  title: string;
  authors: string[];
  journal: string | null;
  pub_year: number | null;
  topic_tags: string[];
  study_design: string;
  confidence: string;
  trust_score: number;
  population: string;
  intervention: string;
  key_finding: string;
  practical_takeaway: string;
  ingested_at: string;
  source_meta: Record<string, unknown> | null;
  contradiction_flags: ContradictionFlag[] | null;
}

interface ResearchStats {
  pending_count: number;
  approved_today: number;
  rejected_today: number;
  kb_total: number;
  last_cron_at: string | null;
}

// Phase 4 cron summary — one row per ingest source. Shows whether the
// nightly cron actually fired AND for each source: lifetime fetched vs
// added, last_error if any. Useful for diagnosing "why didn't I see new
// papers" without opening the Supabase dashboard.
interface IngestSourceState {
  source: string;
  last_run_at: string | null;
  last_pub_date: string | null;
  papers_fetched: number;
  papers_added: number;
  last_error: string | null;
}

// Phase 3 auto-review agent — one row per decision made by the Sonnet
// review agent. Surfaces in the dashboard's "AGENT ACTIVITY" section so
// the admin can audit what got auto-acted overnight + revert anything
// that looks wrong with one tap.
interface AgentLogEntry {
  id: string;
  paper_title: string;
  paper_url: string;
  proposed_action: 'approve' | 'reject' | 'supersede' | 'coexist';
  final_action: 'approve' | 'reject' | 'supersede' | 'coexist';
  downgrade_reason: string | null;
  rationale: string;
  confidence: number;
  flags: string[];
  superseded_kb_ids: string[];
  new_kb_id: string | null;
  agent_model: string;
  decided_at: string;
  reverted_at: string | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function timeSince(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function trustColor(C: any, ts: number): string {
  if (ts >= 0.75) return C.accentText;
  if (ts >= 0.55) return '#a3b900';
  if (ts >= 0.40) return '#d29800';
  return '#c46a4a';
}

// ─── Sources Panel (Phase 4) ────────────────────────────────────────────────
// Per-source cron state: when each source last ran, lifetime counters,
// and any last_error. Answers "why didn't I see new papers last night?"
// without opening Supabase. Collapsed by default — most days you don't
// need to look at it, and an empty queue makes the answer obvious.
function SourcesPanel({ sources }: { sources: IngestSourceState[] }) {
  const { C } = useTheme();
  const [expanded, setExpanded] = useState(false);
  if (sources.length === 0) return null;
  const hasError = sources.some((s) => s.last_error !== null);
  const neverRan = sources.filter((s) => s.last_run_at === null).length;
  const mostRecent = sources
    .map((s) => s.last_run_at)
    .filter((d): d is string => !!d)
    .sort()
    .reverse()[0];

  // Compact summary line shown when collapsed.
  const summary = (() => {
    const parts: string[] = [];
    if (mostRecent) parts.push(`Most recent: ${timeSince(mostRecent)}`);
    else parts.push('Never run');
    if (neverRan > 0) parts.push(`${neverRan} source${neverRan === 1 ? '' : 's'} never run`);
    if (hasError) parts.push(`⚠ has errors`);
    return parts.join(' · ');
  })();

  return (
    <View style={[s.sourcesPanel, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
      <TouchableOpacity
        onPress={() => setExpanded((v) => !v)}
        activeOpacity={0.7}
        style={s.sourcesHeader}
      >
        <Feather name="database" size={12} color={hasError ? '#f87171' : C.textMuted} />
        <Text style={[s.sourcesHeaderLabel, { color: hasError ? '#f87171' : C.textMuted }]}>
          SOURCES ({sources.length})
        </Text>
        <View style={{ flex: 1 }} />
        <Text style={[s.sourcesHeaderSummary, { color: C.mutedFg }]} numberOfLines={1}>
          {summary}
        </Text>
        <Feather name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={C.textMuted} />
      </TouchableOpacity>
      {expanded && (
        <View style={s.sourcesList}>
          {sources.map((src) => {
            const ran = src.last_run_at !== null;
            const errored = src.last_error !== null;
            const accent = errored ? '#f87171' : ran ? C.accentText : C.textMuted;
            return (
              <View key={src.source} style={[s.sourceRow, { borderColor: C.borderSubtle }]}>
                <View style={s.sourceRowTop}>
                  <View style={[s.sourceDot, { backgroundColor: accent }]} />
                  <Text style={[s.sourceName, { color: C.foreground }]}>{src.source}</Text>
                  <View style={{ flex: 1 }} />
                  <Text style={[s.sourceAge, { color: C.textMuted }]}>
                    {ran ? timeSince(src.last_run_at) : 'never run'}
                  </Text>
                </View>
                <Text style={[s.sourceStats, { color: C.mutedFg }]}>
                  {src.papers_fetched} fetched · {src.papers_added} added (lifetime)
                  {src.last_pub_date ? ` · watermark ${src.last_pub_date}` : ''}
                </Text>
                {errored && (
                  <Text style={[s.sourceError, { color: '#f87171' }]} numberOfLines={2}>
                    {src.last_error}
                  </Text>
                )}
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

// ─── Stats Bar ──────────────────────────────────────────────────────────────
function StatsBar({ stats }: { stats: ResearchStats | null }) {
  const { C } = useTheme();
  if (!stats) return null;
  return (
    <View style={s.statsRow}>
      <View style={[s.statCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
        <Text style={[s.statValue, { color: C.foreground }]}>{stats.pending_count}</Text>
        <Text style={[s.statLabel, { color: C.textMuted }]}>Pending</Text>
      </View>
      <View style={[s.statCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
        <Text style={[s.statValue, { color: C.accentText }]}>
          {stats.approved_today}
          <Text style={[s.statValueSecondary, { color: C.textMuted }]}> / {stats.rejected_today}</Text>
        </Text>
        <Text style={[s.statLabel, { color: C.textMuted }]}>Today (✓/✗)</Text>
      </View>
      <View style={[s.statCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
        <Text style={[s.statValue, { color: C.foreground }]}>{stats.kb_total}</Text>
        <Text style={[s.statLabel, { color: C.textMuted }]}>In KB</Text>
      </View>
    </View>
  );
}

// ─── Pending Card ───────────────────────────────────────────────────────────
function PendingCard({
  paper, index, onPress,
}: { paper: PendingPaper; index: number; onPress: () => void }) {
  const { C } = useTheme();
  const tsColor = trustColor(C, paper.trust_score);
  const tags = paper.topic_tags.slice(0, 4);
  const extraTagCount = paper.topic_tags.length - tags.length;
  // Contradiction badge — count only the 'contradict' verdicts on the card
  // (the headline case). 'different_conditions' is real signal too but
  // shows in the detail sheet rather than competing for space here.
  const contradictCount = (paper.contradiction_flags ?? [])
    .filter((f) => f.verdict === 'contradict').length;
  return (
    <Animated.View entering={FadeInDown.delay(index * 60).duration(300)}>
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={0.7}
        style={[s.card, { backgroundColor: C.card, borderColor: C.borderSubtle }]}
      >
        <View style={s.cardTopRow}>
          <View style={[s.trustBadge, { backgroundColor: `${tsColor}22`, borderColor: `${tsColor}55` }]}>
            <Text style={[s.trustBadgeText, { color: tsColor }]}>
              {paper.trust_score.toFixed(2)}
            </Text>
          </View>
          <Text style={[s.designBadge, { color: C.mutedFg }]}>
            {paper.study_design.toUpperCase()}
          </Text>
          {contradictCount > 0 && (
            <View style={[s.conflictBadge, { backgroundColor: 'rgba(239,68,68,0.12)', borderColor: 'rgba(239,68,68,0.30)' }]}>
              <Feather name="alert-triangle" size={9} color="#f87171" />
              <Text style={[s.conflictBadgeText, { color: '#f87171' }]}>
                {contradictCount} conflict{contradictCount === 1 ? '' : 's'}
              </Text>
            </View>
          )}
          <View style={{ flex: 1 }} />
          <Text style={[s.cardAge, { color: C.textMuted }]}>
            {timeSince(paper.ingested_at)}
          </Text>
        </View>

        <Text style={[s.cardTitle, { color: C.foreground }]} numberOfLines={2}>
          {paper.title}
        </Text>

        <Text style={[s.cardTakeaway, { color: C.mutedFg }]} numberOfLines={2}>
          {paper.practical_takeaway}
        </Text>

        <View style={s.tagsRow}>
          {tags.map((t) => (
            <View key={t} style={[s.tag, { backgroundColor: C.muted }]}>
              <Text style={[s.tagText, { color: C.textSecondary }]}>{t}</Text>
            </View>
          ))}
          {extraTagCount > 0 && (
            <View style={[s.tag, { backgroundColor: C.muted }]}>
              <Text style={[s.tagText, { color: C.textMuted }]}>+{extraTagCount}</Text>
            </View>
          )}
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

// ─── Detail Sheet ───────────────────────────────────────────────────────────
function PaperDetailSheet({
  paper, busy, onClose, onApprove, onReject,
}: {
  paper: PendingPaper | null;
  busy: boolean;
  onClose: () => void;
  // Phase 3 supersede: an Approve can also supersede selected existing kb
  // entries. supersedeKbIds is the set of kb_ids the user toggled on via
  // ConflictCard's "Replace this in KB" affordance.
  onApprove: (supersedeKbIds: string[]) => void;
  onReject: (reason: string) => void;
}) {
  const { C } = useTheme();
  const [rejectMode, setRejectMode] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  // kb_ids that should be marked superseded_by the new paper on approve.
  // Populated only when the user toggles the per-conflict "Replace this in
  // KB" button. Always reset when the sheet opens a different paper.
  const [supersedeTargets, setSupersedeTargets] = useState<Set<string>>(new Set());
  const toggleSupersede = (kbId: string) => {
    setSupersedeTargets((prev) => {
      const next = new Set(prev);
      if (next.has(kbId)) next.delete(kbId);
      else next.add(kbId);
      return next;
    });
  };

  useEffect(() => {
    // Reset reject UI + supersede selections whenever a new paper opens
    setRejectMode(false);
    setRejectReason('');
    setSupersedeTargets(new Set());
  }, [paper?.id]);

  // Keyboard avoidance for the reject-reason input. The input autofocuses
  // when reject mode is entered, which immediately pops the keyboard and
  // (without intervention) covers the input + Confirm Reject button. The
  // sheet renders via <Portal> (the app's own window), which isn't
  // auto-resized for the keyboard, so we track keyboard height ourselves and
  // apply marginBottom to the sheet (matches analytics.tsx BottomDrawer).
  const insets = useSafeAreaInsets();
  const [kbHeight, setKbHeight] = useState(0);
  useEffect(() => {
    if (!paper || !rejectMode) { setKbHeight(0); return; }
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, (e) => {
      setKbHeight(e.endCoordinates?.height ?? 0);
    });
    const hideSub = Keyboard.addListener(hideEvt, () => setKbHeight(0));
    return () => { showSub.remove(); hideSub.remove(); };
  }, [paper, rejectMode]);

  // <Portal> has no onRequestClose (unlike RN <Modal>), so wire the Android
  // hardware back button: leave reject mode first if it's active, otherwise
  // dismiss the sheet.
  useEffect(() => {
    if (!paper) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (rejectMode) { setRejectMode(false); setRejectReason(''); return true; }
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [paper, rejectMode, onClose]);

  if (!paper) return null;

  const meta = paper.source_meta ?? {};
  const doi = typeof meta.doi === 'string' ? meta.doi : undefined;
  const pmid = typeof meta.pmid === 'string' ? meta.pmid : undefined;

  return (
    // Rendered via the root <Portal>, not RN <Modal> — on Android edge-to-edge
    // a <Modal> is a separate Dialog window inset by the system nav bar, so a
    // bottom sheet floats above it with a gap (see components/ui/Portal.tsx).
    <Portal>
      <View style={[s.backdrop, { backgroundColor: C.overlay }]}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
        <Animated.View
          entering={SlideInDown.duration(350).easing(Easing.out(Easing.cubic))}
          exiting={SlideOutDown.duration(200)}
          style={[
            s.sheet,
            {
              backgroundColor: C.background,
              // Lift above the keyboard on both platforms — the portal window
              // isn't auto-resized. See kbHeight tracking above.
              marginBottom: kbHeight,
              // Flush with the screen bottom now, so pad the action bar past
              // the home indicator / gesture bar.
              paddingBottom: insets.bottom,
            },
          ]}
        >
          <View style={[s.handleWrap]}>
            <View style={[s.handle, { backgroundColor: C.handle ?? C.border }]} />
          </View>

          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={s.sheetContent}
            showsVerticalScrollIndicator={false}
          >
            {/* Title + meta */}
            <Text style={[s.sheetTitle, { color: C.foreground }]}>{paper.title}</Text>
            <Text style={[s.sheetSub, { color: C.mutedFg }]}>
              {paper.authors.slice(0, 3).join(', ')}{paper.authors.length > 3 ? ` +${paper.authors.length - 3}` : ''}
              {paper.journal ? ` · ${paper.journal}` : ''}
              {paper.pub_year ? ` · ${paper.pub_year}` : ''}
            </Text>

            {/* Badge row */}
            <View style={s.sheetBadgeRow}>
              <View style={[s.sheetBadge, { backgroundColor: `${trustColor(C, paper.trust_score)}22`, borderColor: `${trustColor(C, paper.trust_score)}55` }]}>
                <Text style={[s.sheetBadgeText, { color: trustColor(C, paper.trust_score) }]}>
                  trust {paper.trust_score.toFixed(2)}
                </Text>
              </View>
              <View style={[s.sheetBadge, { backgroundColor: C.muted, borderColor: C.borderSubtle }]}>
                <Text style={[s.sheetBadgeText, { color: C.textSecondary }]}>{paper.study_design}</Text>
              </View>
              <View style={[s.sheetBadge, { backgroundColor: C.muted, borderColor: C.borderSubtle }]}>
                <Text style={[s.sheetBadgeText, { color: C.textSecondary }]}>{paper.confidence}</Text>
              </View>
            </View>

            {/* Source link */}
            {paper.url && (
              <TouchableOpacity
                onPress={() => Linking.openURL(paper.url).catch(() => {})}
                style={[s.sourceLink, { backgroundColor: C.muted, borderColor: C.borderSubtle }]}
              >
                <Feather name="external-link" size={13} color={C.accentText} />
                <Text style={[s.sourceLinkText, { color: C.accentText }]} numberOfLines={1}>
                  Open source{doi ? ` (DOI: ${doi.slice(0, 30)})` : pmid ? ` (PMID: ${pmid})` : ''}
                </Text>
              </TouchableOpacity>
            )}

            {/* Possible conflicts (Phase 3 contradiction detection).
                Surfaced ABOVE the distillation so reviewers see disagreements
                with existing kb entries before they read the new paper's
                takeaway. Each flag carries Haiku's verdict + rationale +
                a similarity score and links to the existing kb entry. */}
            {paper.contradiction_flags && paper.contradiction_flags.length > 0 && (
              <>
                <SectionLabel>POSSIBLE CONFLICTS</SectionLabel>
                {paper.contradiction_flags.map((f, i) => (
                  <ConflictCard
                    key={`${f.kb_id}-${i}`}
                    flag={f}
                    supersedeOn={supersedeTargets.has(f.kb_id)}
                    onToggleSupersede={() => toggleSupersede(f.kb_id)}
                  />
                ))}
              </>
            )}

            {/* Distillation */}
            <SectionLabel>DISTILLATION</SectionLabel>
            <Field label="Population" value={paper.population} />
            <Field label="Intervention" value={paper.intervention} />
            <Field label="Key finding" value={paper.key_finding} highlight />
            <Field label="Practical takeaway" value={paper.practical_takeaway} highlight />

            {/* Topics */}
            <SectionLabel>TOPIC TAGS</SectionLabel>
            <View style={s.tagsRow}>
              {paper.topic_tags.map((t) => (
                <View key={t} style={[s.tag, { backgroundColor: C.muted }]}>
                  <Text style={[s.tagText, { color: C.textSecondary }]}>{t}</Text>
                </View>
              ))}
            </View>

            {/* HyDE questions — pulled from source_meta if present */}
            {Array.isArray((meta as any).hyde_questions) && (meta as any).hyde_questions.length > 0 && (
              <>
                <SectionLabel>QUESTIONS THIS ANSWERS</SectionLabel>
                {((meta as any).hyde_questions as string[]).map((q, i) => (
                  <Text key={i} style={[s.hydeQ, { color: C.mutedFg }]}>• {q}</Text>
                ))}
              </>
            )}
          </ScrollView>

          {/* Action bar — keyboard avoidance is handled at the sheet level
              (marginBottom: kbHeight), not via KeyboardAvoidingView, because
              the portal window isn't auto-resized for the keyboard. */}
          <View>
            {rejectMode ? (
              <View style={[s.actionBar, { backgroundColor: C.background, borderColor: C.borderSubtle }]}>
                <TextInput
                  value={rejectReason}
                  onChangeText={setRejectReason}
                  placeholder="Reason (small-n, irrelevant population, paywall, etc.)"
                  placeholderTextColor={C.textMuted}
                  style={[s.reasonInput, { color: C.foreground, backgroundColor: C.inputBg, borderColor: C.border }]}
                  multiline
                  maxLength={200}
                  autoFocus
                  editable={!busy}
                />
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TouchableOpacity
                    onPress={() => { setRejectMode(false); setRejectReason(''); }}
                    disabled={busy}
                    style={[s.smallBtn, { backgroundColor: C.muted }]}
                  >
                    <Text style={[s.smallBtnText, { color: C.foreground }]}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => onReject(rejectReason.trim() || 'no reason given')}
                    disabled={busy}
                    style={[s.smallBtn, { backgroundColor: '#f87171', flex: 1, opacity: busy ? 0.6 : 1 }]}
                  >
                    {busy ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Text style={[s.smallBtnText, { color: '#fff', fontWeight: FontWeight.bold }]}>
                        Confirm Reject
                      </Text>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <View style={[s.actionBar, { backgroundColor: C.background, borderColor: C.borderSubtle }]}>
                <TouchableOpacity
                  onPress={() => setRejectMode(true)}
                  disabled={busy}
                  style={[s.actionBtnSecondary, { backgroundColor: 'rgba(239,68,68,0.10)', borderColor: 'rgba(239,68,68,0.20)' }]}
                >
                  <Feather name="x" size={14} color="#f87171" />
                  <Text style={[s.actionBtnSecondaryText, { color: '#f87171' }]}>Reject</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => onApprove(Array.from(supersedeTargets))}
                  disabled={busy}
                  style={[s.actionBtnPrimary, { opacity: busy ? 0.6 : 1 }]}
                >
                  {busy ? (
                    <ActivityIndicator size="small" color={Colors.primaryFg} />
                  ) : (
                    <>
                      <Feather name="check" size={14} color={Colors.primaryFg} />
                      <Text style={s.actionBtnPrimaryText}>
                        {supersedeTargets.size > 0
                          ? `Approve + Replace ${supersedeTargets.size}`
                          : 'Approve to KB'}
                      </Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            )}
          </View>
        </Animated.View>
      </View>
    </Portal>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  const { C } = useTheme();
  return <Text style={[s.sectionLabel, { color: C.textMuted }]}>{children}</Text>;
}

function Field({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  const { C } = useTheme();
  if (!value) return null;
  return (
    <View style={s.fieldRow}>
      <Text style={[s.fieldLabel, { color: C.textMuted }]}>{label}</Text>
      <Text style={[
        s.fieldValue,
        { color: highlight ? C.foreground : C.mutedFg },
        highlight && { fontWeight: FontWeight.medium },
      ]}>
        {value}
      </Text>
    </View>
  );
}

// ─── ConflictCard ──────────────────────────────────────────────────────────
// Side-by-side surfacing of a single contradiction flag. Shows verdict,
// similarity, Haiku rationale, and a snippet of the existing kb entry's
// finding so the reviewer can judge "is this paper actually contradicting,
// or just covering different conditions?"
//
// Phase 3 supersede: for `contradict` verdicts, exposes a toggle that lets
// the reviewer say "mark this kb entry as superseded by the new paper when
// I approve". Toggling off is a no-op; the kb stays. Different-conditions
// verdicts don't get the toggle — coexist is the right call for those.
function ConflictCard({
  flag, supersedeOn, onToggleSupersede,
}: {
  flag: ContradictionFlag;
  supersedeOn: boolean;
  onToggleSupersede: () => void;
}) {
  const { C } = useTheme();
  const isContradict = flag.verdict === 'contradict';
  const verdictColor = isContradict ? '#f87171' : '#d29800'; // red vs amber
  const verdictBg = isContradict ? 'rgba(239,68,68,0.10)' : 'rgba(210,152,0,0.10)';
  const verdictBorder = isContradict ? 'rgba(239,68,68,0.30)' : 'rgba(210,152,0,0.30)';
  const verdictLabel = isContradict ? 'Contradicts' : 'Different conditions';
  return (
    <View style={[s.conflictCard, { backgroundColor: verdictBg, borderColor: verdictBorder }]}>
      <View style={s.conflictHeader}>
        <Feather name={isContradict ? 'alert-triangle' : 'git-branch'} size={12} color={verdictColor} />
        <Text style={[s.conflictVerdict, { color: verdictColor }]}>
          {verdictLabel}
        </Text>
        <View style={{ flex: 1 }} />
        <Text style={[s.conflictMeta, { color: C.textMuted }]}>
          sim {flag.similarity.toFixed(2)} · conf {flag.confidence.toFixed(2)}
        </Text>
      </View>
      <Text style={[s.conflictKbTitle, { color: C.foreground }]} numberOfLines={2}>
        vs. {flag.kb_title}
      </Text>
      <Text style={[s.conflictKbFinding, { color: C.mutedFg }]} numberOfLines={3}>
        “{flag.kb_finding}”
      </Text>
      <Text style={[s.conflictRationale, { color: C.foreground }]}>
        {flag.rationale}
      </Text>
      <Text style={[s.conflictKbMeta, { color: C.textMuted }]}>
        {flag.kb_study_design} · trust {flag.kb_trust_score.toFixed(2)}
      </Text>

      {isContradict && (
        <TouchableOpacity
          onPress={onToggleSupersede}
          activeOpacity={0.7}
          style={[
            s.supersedeToggle,
            supersedeOn
              ? { backgroundColor: verdictColor, borderColor: verdictColor }
              : { backgroundColor: 'transparent', borderColor: verdictBorder },
          ]}
        >
          <Feather
            name={supersedeOn ? 'check-square' : 'square'}
            size={12}
            color={supersedeOn ? '#fff' : verdictColor}
          />
          <Text
            style={[
              s.supersedeToggleText,
              { color: supersedeOn ? '#fff' : verdictColor },
            ]}
          >
            {supersedeOn ? 'Will replace in KB on approve' : 'Replace this in KB on approve'}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ─── AgentActivityCard ──────────────────────────────────────────────────────
// One row per agent_review_log entry. Compact: action chip, paper title,
// timestamp, rationale snippet, downgrade indicator (if guardrails fired),
// revert button. Tapping the title opens the source URL.
function AgentActivityCard({
  entry, busy, onRevert,
}: {
  entry: AgentLogEntry;
  busy: boolean;
  onRevert: () => void;
}) {
  const { C } = useTheme();
  const actionColors: Record<AgentLogEntry['final_action'], string> = {
    approve: '#84cc16',     // lime
    reject: '#f87171',      // red
    supersede: '#ec4899',   // pink
    coexist: '#06b6d4',     // cyan
  };
  const c = actionColors[entry.final_action] ?? C.mutedFg;
  const downgraded = entry.proposed_action !== entry.final_action;

  return (
    <View style={[s.agentCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
      <View style={s.agentCardHeader}>
        <View style={[s.agentChip, { backgroundColor: `${c}22`, borderColor: `${c}55` }]}>
          <Text style={[s.agentChipText, { color: c }]}>
            {entry.final_action.toUpperCase()}
          </Text>
        </View>
        {downgraded && (
          <View style={[s.agentChip, { backgroundColor: 'rgba(210,152,0,0.12)', borderColor: 'rgba(210,152,0,0.30)' }]}>
            <Feather name="corner-down-right" size={9} color="#d29800" />
            <Text style={[s.agentChipText, { color: '#d29800' }]}>
              downgraded
            </Text>
          </View>
        )}
        <View style={[s.agentChip, { backgroundColor: C.muted, borderColor: 'transparent' }]}>
          <Text style={[s.agentChipText, { color: C.textMuted }]}>
            conf {entry.confidence.toFixed(2)}
          </Text>
        </View>
        <View style={{ flex: 1 }} />
        <Text style={[s.agentTime, { color: C.textMuted }]}>
          {timeSince(entry.decided_at)}
        </Text>
      </View>

      <TouchableOpacity
        onPress={() => entry.paper_url && Linking.openURL(entry.paper_url).catch(() => {})}
        activeOpacity={0.7}
      >
        <Text style={[s.agentPaperTitle, { color: C.foreground }]} numberOfLines={2}>
          {entry.paper_title}
        </Text>
      </TouchableOpacity>

      <Text style={[s.agentRationale, { color: C.mutedFg }]} numberOfLines={3}>
        {entry.rationale}
      </Text>

      {downgraded && entry.downgrade_reason && (
        <Text style={[s.agentDowngradeReason, { color: '#d29800' }]} numberOfLines={2}>
          ↳ {entry.downgrade_reason}
        </Text>
      )}

      {entry.flags.length > 0 && (
        <View style={s.tagsRow}>
          {entry.flags.slice(0, 6).map((f) => (
            <View key={f} style={[s.tag, { backgroundColor: C.muted }]}>
              <Text style={[s.tagText, { color: C.textMuted }]}>{f}</Text>
            </View>
          ))}
        </View>
      )}

      <TouchableOpacity
        onPress={onRevert}
        disabled={busy}
        style={[s.revertBtn, { borderColor: C.borderSubtle, backgroundColor: C.muted, opacity: busy ? 0.5 : 1 }]}
        activeOpacity={0.7}
      >
        {busy ? (
          <ActivityIndicator size="small" color={C.textMuted} />
        ) : (
          <>
            <Feather name="rotate-ccw" size={11} color={C.foreground} />
            <Text style={[s.revertBtnText, { color: C.foreground }]}>Revert</Text>
          </>
        )}
      </TouchableOpacity>
    </View>
  );
}

// ─── Main Screen ────────────────────────────────────────────────────────────
export default function ResearchReviewScreen() {
  const { C } = useTheme();
  const router = useRouter();
  const supabase = useSupabaseClient();
  const { isAdmin, loading: adminLoading } = useAdminCheck();

  const [stats, setStats] = useState<ResearchStats | null>(null);
  const [papers, setPapers] = useState<PendingPaper[]>([]);
  const [agentLog, setAgentLog] = useState<AgentLogEntry[]>([]);
  const [sources, setSources] = useState<IngestSourceState[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedPaper, setSelectedPaper] = useState<PendingPaper | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [revertingLogId, setRevertingLogId] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [papersRes, statsRes, agentLogRes, sourcesRes] = await Promise.all([
        supabase
          .from('research_kb_pending')
          .select('id, source, url, title, authors, journal, pub_year, topic_tags, study_design, confidence, trust_score, population, intervention, key_finding, practical_takeaway, ingested_at, source_meta, contradiction_flags')
          .eq('review_status', 'pending')
          .order('ingested_at', { ascending: true })
          .limit(50),
        supabase.rpc('admin_research_stats').single(),
        supabase
          .from('agent_review_log')
          .select('id, paper_title, paper_url, proposed_action, final_action, downgrade_reason, rationale, confidence, flags, superseded_kb_ids, new_kb_id, agent_model, decided_at, reverted_at')
          .is('reverted_at', null)
          .order('decided_at', { ascending: false })
          .limit(20),
        // Phase 4 cron summary: per-source ingest state for the SOURCES card.
        // Admin RLS on ingest_checkpoints lets us read this directly.
        supabase
          .from('ingest_checkpoints')
          .select('source, last_run_at, last_pub_date, papers_fetched, papers_added, last_error')
          .order('last_run_at', { ascending: false, nullsFirst: false }),
      ]);
      if (papersRes.data) {
        setPapers(papersRes.data.map((p) => ({
          ...p,
          trust_score: Number(p.trust_score),
        })) as PendingPaper[]);
      }
      if (statsRes.data) {
        // The RPC return shape is opaque to TS (`.single()` types it as {}),
        // so we cast through Record<string, unknown> and coerce each field
        // explicitly. Numeric fields come back as bigint-strings from
        // PostgREST when the underlying count() is bigint.
        const raw = statsRes.data as Record<string, unknown>;
        setStats({
          pending_count: Number(raw.pending_count ?? 0),
          approved_today: Number(raw.approved_today ?? 0),
          rejected_today: Number(raw.rejected_today ?? 0),
          kb_total: Number(raw.kb_total ?? 0),
          last_cron_at: typeof raw.last_cron_at === 'string' ? raw.last_cron_at : null,
        });
      }
      if (agentLogRes.data) {
        setAgentLog(agentLogRes.data.map((r) => ({
          ...r,
          confidence: Number(r.confidence),
        })) as AgentLogEntry[]);
      }
      if (sourcesRes.data) {
        setSources(sourcesRes.data.map((r) => ({
          ...r,
          papers_fetched: Number(r.papers_fetched ?? 0),
          papers_added: Number(r.papers_added ?? 0),
        })) as IngestSourceState[]);
      }
    } catch (e) {
      setBanner({ kind: 'err', text: `Failed to load: ${String(e).slice(0, 100)}` });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [supabase]);

  const handleRevert = useCallback(async (logId: string) => {
    setRevertingLogId(logId);
    try {
      const { error } = await supabase.rpc('revert_agent_decision', {
        p_log_id: logId,
      });
      if (error) throw new Error(error.message);
      setBanner({ kind: 'ok', text: 'Reverted — paper back in pending queue' });
      // Optimistic: remove from agent log + refetch to update pending queue
      setAgentLog((prev) => prev.filter((l) => l.id !== logId));
      fetchData();
    } catch (e) {
      setBanner({ kind: 'err', text: `Revert failed: ${String(e).slice(0, 120)}` });
    } finally {
      setRevertingLogId(null);
    }
  }, [supabase, fetchData]);

  useEffect(() => {
    if (!adminLoading && isAdmin) fetchData();
    else if (!adminLoading && !isAdmin) setLoading(false);
  }, [adminLoading, isAdmin, fetchData]);

  // Auto-dismiss the banner after 4s
  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => setBanner(null), 4000);
    return () => clearTimeout(t);
  }, [banner]);

  const handleApprove = useCallback(async (supersedeKbIds: string[] = []) => {
    if (!selectedPaper) return;
    setActionBusy(true);
    try {
      // promote_pending_to_kb returns the new kb_id; we need it to wire the
      // supersede_by links from the selected old kb entries to this new one.
      const { data: newKbId, error } = await supabase.rpc('promote_pending_to_kb', {
        p_pending_id: selectedPaper.id,
      });
      if (error) throw new Error(error.message);

      // Soft-supersede each kb_id the reviewer toggled. Done sequentially so
      // a partial failure (e.g. one row already superseded) doesn't abandon
      // the rest. Failures bubble up as banner errors but the approve has
      // already succeeded, so the new kb entry stays.
      let superseded = 0;
      const supersedeErrors: string[] = [];
      if (newKbId && supersedeKbIds.length > 0) {
        for (const kbId of supersedeKbIds) {
          const { error: sErr } = await supabase.rpc('supersede_kb', {
            p_superseded_id: kbId,
            p_by_id: newKbId as string,
          });
          if (sErr) supersedeErrors.push(sErr.message);
          else superseded += 1;
        }
      }

      if (supersedeErrors.length > 0) {
        setBanner({
          kind: 'err',
          text: `Approved, but ${supersedeErrors.length} supersede(s) failed: ${supersedeErrors[0].slice(0, 80)}`,
        });
      } else if (superseded > 0) {
        setBanner({ kind: 'ok', text: `Approved + replaced ${superseded} kb entr${superseded === 1 ? 'y' : 'ies'}` });
      } else {
        setBanner({ kind: 'ok', text: `Approved — added to research_kb` });
      }
      setSelectedPaper(null);
      // Optimistic removal; refetch to confirm + update stats
      setPapers((prev) => prev.filter((p) => p.id !== selectedPaper.id));
      fetchData();
    } catch (e) {
      setBanner({ kind: 'err', text: `Approve failed: ${String(e).slice(0, 100)}` });
    } finally {
      setActionBusy(false);
    }
  }, [selectedPaper, supabase, fetchData]);

  const handleReject = useCallback(async (reason: string) => {
    if (!selectedPaper) return;
    setActionBusy(true);
    try {
      const { error } = await supabase.rpc('reject_pending', {
        p_pending_id: selectedPaper.id,
        p_reason: reason,
      });
      if (error) throw new Error(error.message);
      setBanner({ kind: 'ok', text: `Rejected` });
      setSelectedPaper(null);
      setPapers((prev) => prev.filter((p) => p.id !== selectedPaper.id));
      fetchData();
    } catch (e) {
      setBanner({ kind: 'err', text: `Reject failed: ${String(e).slice(0, 100)}` });
    } finally {
      setActionBusy(false);
    }
  }, [selectedPaper, supabase, fetchData]);

  // ── Auth / loading gates ───────────────────────────────────────────────────
  if (adminLoading) {
    return (
      <SafeAreaView style={[s.container, { backgroundColor: C.background }]} edges={['top']}>
        <ActivityIndicator size="small" color={C.accentText} style={{ marginTop: 40 }} />
      </SafeAreaView>
    );
  }
  if (!isAdmin) {
    return (
      <SafeAreaView style={[s.container, { backgroundColor: C.background }]} edges={['top']}>
        <View style={s.headerRow}>
          <TouchableOpacity onPress={() => router.back()} style={[s.backBtn, { backgroundColor: C.muted }]}>
            <Feather name="arrow-left" size={16} color={C.foreground} />
          </TouchableOpacity>
        </View>
        <View style={s.noAccessWrap}>
          <Feather name="lock" size={32} color={C.textMuted} />
          <Text style={[s.noAccessTitle, { color: C.foreground }]}>Admin access required</Text>
          <Text style={[s.noAccessSub, { color: C.mutedFg }]}>
            This page is for project administrators only.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  // ── Main content ──────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={[s.container, { backgroundColor: C.background }]} edges={['top']}>
      <View style={s.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={[s.backBtn, { backgroundColor: C.muted }]}>
          <Feather name="arrow-left" size={16} color={C.foreground} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={[s.headerTitle, { color: C.foreground }]}>Research Review</Text>
          <Text style={[s.headerSub, { color: C.textMuted }]}>
            Last cron: {timeSince(stats?.last_cron_at)}
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => { setRefreshing(true); fetchData(); }}
          style={[s.backBtn, { backgroundColor: C.muted }]}
        >
          <Feather name="refresh-cw" size={14} color={C.foreground} />
        </TouchableOpacity>
      </View>

      {banner && (
        <Animated.View
          entering={FadeInDown.duration(180)}
          style={[
            s.banner,
            banner.kind === 'ok'
              ? { backgroundColor: C.primarySubtle, borderColor: C.borderSubtle }
              : { backgroundColor: 'rgba(239,68,68,0.10)', borderColor: 'rgba(239,68,68,0.25)' },
          ]}
        >
          <Feather
            name={banner.kind === 'ok' ? 'check-circle' : 'alert-circle'}
            size={14}
            color={banner.kind === 'ok' ? C.accentText : '#f87171'}
          />
          <Text style={[s.bannerText, { color: banner.kind === 'ok' ? C.accentText : '#f87171' }]}>
            {banner.text}
          </Text>
        </Animated.View>
      )}

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); fetchData(); }}
            tintColor={C.accentText}
          />
        }
      >
        <StatsBar stats={stats} />
        <SourcesPanel sources={sources} />

        {loading ? (
          <View style={{ alignItems: 'center', paddingVertical: 40 }}>
            <ActivityIndicator size="small" color={C.accentText} />
          </View>
        ) : papers.length === 0 ? (
          <View style={[s.emptyState, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
            <Feather name="inbox" size={28} color={C.textMuted} />
            <Text style={[s.emptyTitle, { color: C.foreground }]}>Nothing waiting</Text>
            <Text style={[s.emptySub, { color: C.mutedFg }]}>
              The queue is clear. The cron will land new papers overnight.
            </Text>
          </View>
        ) : (
          <>
            <Text style={[s.queueLabel, { color: C.textMuted }]}>
              PENDING REVIEW ({papers.length})
            </Text>
            {papers.map((p, i) => (
              <PendingCard
                key={p.id}
                paper={p}
                index={i}
                onPress={() => setSelectedPaper(p)}
              />
            ))}
          </>
        )}

        {/* Agent activity (Phase 3 auto-review audit log). Last 20 live
            (un-reverted) decisions across approve/reject/supersede/coexist
            so the admin can spot-check what the agent did overnight and
            revert anything wrong with a tap. */}
        {agentLog.length > 0 && (
          <>
            <Text style={[s.queueLabel, { color: C.textMuted, marginTop: 24 }]}>
              AGENT ACTIVITY ({agentLog.length})
            </Text>
            {agentLog.map((entry) => (
              <AgentActivityCard
                key={entry.id}
                entry={entry}
                busy={revertingLogId === entry.id}
                onRevert={() => handleRevert(entry.id)}
              />
            ))}
          </>
        )}
      </ScrollView>

      <PaperDetailSheet
        paper={selectedPaper}
        busy={actionBusy}
        onClose={() => !actionBusy && setSelectedPaper(null)}
        onApprove={handleApprove}
        onReject={handleReject}
      />
    </SafeAreaView>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  container: { flex: 1 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
  },
  backBtn: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: {
    fontSize: FontSize.xl, fontWeight: FontWeight.bold,
  },
  headerSub: {
    fontSize: FontSize.xs, marginTop: 2,
  },

  banner: {
    marginHorizontal: Spacing.xl,
    marginBottom: Spacing.sm,
    padding: Spacing.md,
    borderRadius: Radius.md,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  bannerText: { fontSize: FontSize.sm, flex: 1 },

  scrollContent: {
    padding: Spacing.xl,
    paddingTop: 4,
    paddingBottom: 80,
    gap: 12,
  },

  statsRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: Spacing.md,
  },

  // Phase 4 cron summary panel
  sourcesPanel: {
    borderRadius: Radius.lg,
    borderWidth: 1,
    marginBottom: Spacing.md,
  },
  sourcesHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
  },
  sourcesHeaderLabel: {
    fontSize: 10,
    fontWeight: FontWeight.bold,
    letterSpacing: 1.2,
  },
  sourcesHeaderSummary: {
    fontSize: FontSize.xs,
    marginRight: 6,
    maxWidth: 200,
  },
  sourcesList: {
    paddingHorizontal: Spacing.md,
    paddingBottom: 10,
    gap: 8,
  },
  sourceRow: {
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 4,
  },
  sourceRowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sourceDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  sourceName: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    fontVariant: ['tabular-nums'],
  },
  sourceAge: {
    fontSize: FontSize.xs,
    fontVariant: ['tabular-nums'],
  },
  sourceStats: {
    fontSize: FontSize.xs,
    fontVariant: ['tabular-nums'],
  },
  sourceError: {
    fontSize: FontSize.xs,
    fontStyle: 'italic',
    marginTop: 2,
  },

  statCard: {
    flex: 1,
    padding: Spacing.md,
    borderRadius: Radius.lg,
    borderWidth: 1,
    alignItems: 'flex-start',
  },
  statValue: {
    fontSize: FontSize.xxl,
    fontWeight: FontWeight.bold,
    fontVariant: ['tabular-nums'],
  },
  statValueSecondary: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.medium,
  },
  statLabel: {
    fontSize: FontSize.xs,
    marginTop: 4,
    letterSpacing: 0.5,
  },

  queueLabel: {
    fontSize: 10,
    fontWeight: FontWeight.bold,
    letterSpacing: 1.5,
    marginBottom: 4,
    marginTop: 4,
  },

  card: {
    padding: Spacing.lg,
    borderRadius: Radius.xl,
    borderWidth: 1,
    gap: 8,
  },
  cardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  trustBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: Radius.full ?? 999,
    borderWidth: 1,
  },
  trustBadgeText: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    fontVariant: ['tabular-nums'],
  },
  designBadge: {
    fontSize: 10,
    fontWeight: FontWeight.semibold,
    letterSpacing: 0.5,
  },
  conflictBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: Radius.full ?? 999,
    borderWidth: 1,
  },
  conflictBadgeText: {
    fontSize: 10,
    fontWeight: FontWeight.bold,
    letterSpacing: 0.3,
  },
  cardAge: {
    fontSize: FontSize.xs,
  },

  // Detail-sheet conflict card (Phase 3 contradiction surface)
  conflictCard: {
    padding: 12,
    borderRadius: Radius.md,
    borderWidth: 1,
    gap: 6,
    marginBottom: 8,
  },
  conflictHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  conflictVerdict: {
    fontSize: 11,
    fontWeight: FontWeight.bold,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  conflictMeta: {
    fontSize: 10,
    fontVariant: ['tabular-nums'],
  },
  conflictKbTitle: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    lineHeight: 18,
  },
  conflictKbFinding: {
    fontSize: FontSize.xs,
    fontStyle: 'italic',
    lineHeight: 16,
  },
  conflictRationale: {
    fontSize: FontSize.sm,
    lineHeight: 18,
    marginTop: 2,
  },
  conflictKbMeta: {
    fontSize: 10,
    marginTop: 2,
  },
  supersedeToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: Radius.md,
    borderWidth: 1,
    marginTop: 8,
    alignSelf: 'flex-start',
  },
  supersedeToggleText: {
    fontSize: 11,
    fontWeight: FontWeight.semibold,
    letterSpacing: 0.2,
  },

  // Phase 3 auto-review agent activity log
  agentCard: {
    padding: Spacing.lg,
    borderRadius: Radius.xl,
    borderWidth: 1,
    gap: 8,
  },
  agentCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  agentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: Radius.full ?? 999,
    borderWidth: 1,
  },
  agentChipText: {
    fontSize: 10,
    fontWeight: FontWeight.bold,
    letterSpacing: 0.3,
  },
  agentTime: {
    fontSize: FontSize.xs,
  },
  agentPaperTitle: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    lineHeight: 20,
  },
  agentRationale: {
    fontSize: FontSize.sm,
    lineHeight: 18,
  },
  agentDowngradeReason: {
    fontSize: FontSize.xs,
    fontStyle: 'italic',
    lineHeight: 16,
  },
  revertBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: Radius.md,
    borderWidth: 1,
    alignSelf: 'flex-start',
    marginTop: 4,
  },
  revertBtnText: {
    fontSize: 11,
    fontWeight: FontWeight.semibold,
  },

  cardTitle: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
    lineHeight: 20,
  },
  cardTakeaway: {
    fontSize: FontSize.sm,
    lineHeight: 17,
  },
  tagsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  tag: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: Radius.full ?? 999,
  },
  tagText: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.medium,
  },

  emptyState: {
    padding: Spacing.xxxl,
    borderRadius: Radius.xl,
    borderWidth: 1,
    alignItems: 'center',
    gap: 8,
  },
  emptyTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.semibold,
    marginTop: 4,
  },
  emptySub: {
    fontSize: FontSize.sm,
    textAlign: 'center',
    maxWidth: 280,
  },

  noAccessWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: Spacing.xl,
  },
  noAccessTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.semibold,
    marginTop: 8,
  },
  noAccessSub: {
    fontSize: FontSize.sm,
    textAlign: 'center',
    maxWidth: 280,
  },

  // Detail sheet
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    height: '92%',
    borderTopLeftRadius: Radius.xxl,
    borderTopRightRadius: Radius.xxl,
    overflow: 'hidden',
  },
  handleWrap: {
    paddingTop: 10,
    paddingBottom: 6,
    alignItems: 'center',
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
  },
  sheetContent: {
    padding: Spacing.xl,
    paddingBottom: 24,
    gap: 6,
  },
  sheetTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    lineHeight: 22,
    marginBottom: 4,
  },
  sheetSub: {
    fontSize: FontSize.xs,
    marginBottom: Spacing.sm,
  },
  sheetBadgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: Spacing.md,
  },
  sheetBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: Radius.full ?? 999,
    borderWidth: 1,
  },
  sheetBadgeText: {
    fontSize: 11,
    fontWeight: FontWeight.semibold,
  },
  sourceLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    padding: 10,
    borderRadius: Radius.md,
    borderWidth: 1,
    marginBottom: Spacing.md,
  },
  sourceLinkText: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.medium,
    flex: 1,
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: FontWeight.bold,
    letterSpacing: 1.5,
    marginTop: Spacing.md,
    marginBottom: 4,
  },
  fieldRow: {
    paddingVertical: 4,
  },
  fieldLabel: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.medium,
    marginBottom: 2,
  },
  fieldValue: {
    fontSize: FontSize.sm,
    lineHeight: 18,
  },
  hydeQ: {
    fontSize: FontSize.sm,
    lineHeight: 18,
    fontStyle: 'italic',
    paddingVertical: 2,
  },

  // Action bar
  actionBar: {
    flexDirection: 'row',
    gap: 8,
    padding: Spacing.lg,
    paddingBottom: 30,
    borderTopWidth: 1,
  },
  actionBtnPrimary: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 48,
    borderRadius: Radius.xl,
    backgroundColor: Colors.primary,
  },
  actionBtnPrimaryText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
    color: Colors.primaryFg,
  },
  actionBtnSecondary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 48,
    paddingHorizontal: 18,
    borderRadius: Radius.xl,
    borderWidth: 1,
  },
  actionBtnSecondaryText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
  },
  reasonInput: {
    minHeight: 48,
    maxHeight: 96,
    borderRadius: Radius.lg,
    borderWidth: 1,
    padding: Spacing.md,
    fontSize: FontSize.sm,
  },
  smallBtn: {
    height: 44,
    paddingHorizontal: 16,
    borderRadius: Radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallBtnText: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
  },
});
