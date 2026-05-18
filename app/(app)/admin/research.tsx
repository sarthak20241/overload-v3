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
  ActivityIndicator, Modal, Pressable, TextInput,
  KeyboardAvoidingView, Platform, Linking, RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import Animated, {
  FadeInDown, SlideInDown, SlideOutDown, Easing,
} from 'react-native-reanimated';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { useSupabaseClient } from '@/lib/supabase';
import { useAdminCheck } from '@/hooks/useAdminCheck';

// ─── Types ──────────────────────────────────────────────────────────────────
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
}

interface ResearchStats {
  pending_count: number;
  approved_today: number;
  rejected_today: number;
  kb_total: number;
  last_cron_at: string | null;
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
  onApprove: () => void;
  onReject: (reason: string) => void;
}) {
  const { C } = useTheme();
  const [rejectMode, setRejectMode] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  useEffect(() => {
    // Reset reject UI whenever a new paper opens
    setRejectMode(false);
    setRejectReason('');
  }, [paper?.id]);

  if (!paper) return null;

  const meta = paper.source_meta ?? {};
  const doi = typeof meta.doi === 'string' ? meta.doi : undefined;
  const pmid = typeof meta.pmid === 'string' ? meta.pmid : undefined;

  return (
    <Modal visible={paper !== null} transparent animationType="none" onRequestClose={onClose}>
      <View style={[s.backdrop, { backgroundColor: C.overlay }]}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
        <Animated.View
          entering={SlideInDown.duration(350).easing(Easing.out(Easing.cubic))}
          exiting={SlideOutDown.duration(200)}
          style={[s.sheet, { backgroundColor: C.background }]}
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

          {/* Action bar */}
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            keyboardVerticalOffset={0}
          >
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
                  onPress={onApprove}
                  disabled={busy}
                  style={[s.actionBtnPrimary, { opacity: busy ? 0.6 : 1 }]}
                >
                  {busy ? (
                    <ActivityIndicator size="small" color={Colors.primaryFg} />
                  ) : (
                    <>
                      <Feather name="check" size={14} color={Colors.primaryFg} />
                      <Text style={s.actionBtnPrimaryText}>Approve to KB</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            )}
          </KeyboardAvoidingView>
        </Animated.View>
      </View>
    </Modal>
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

// ─── Main Screen ────────────────────────────────────────────────────────────
export default function ResearchReviewScreen() {
  const { C } = useTheme();
  const router = useRouter();
  const supabase = useSupabaseClient();
  const { isAdmin, loading: adminLoading } = useAdminCheck();

  const [stats, setStats] = useState<ResearchStats | null>(null);
  const [papers, setPapers] = useState<PendingPaper[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedPaper, setSelectedPaper] = useState<PendingPaper | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [papersRes, statsRes] = await Promise.all([
        supabase
          .from('research_kb_pending')
          .select('id, source, url, title, authors, journal, pub_year, topic_tags, study_design, confidence, trust_score, population, intervention, key_finding, practical_takeaway, ingested_at, source_meta')
          .eq('review_status', 'pending')
          .order('ingested_at', { ascending: true })
          .limit(50),
        supabase.rpc('admin_research_stats').single(),
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
    } catch (e) {
      setBanner({ kind: 'err', text: `Failed to load: ${String(e).slice(0, 100)}` });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [supabase]);

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

  const handleApprove = useCallback(async () => {
    if (!selectedPaper) return;
    setActionBusy(true);
    try {
      const { error } = await supabase.rpc('promote_pending_to_kb', {
        p_pending_id: selectedPaper.id,
      });
      if (error) throw new Error(error.message);
      setBanner({ kind: 'ok', text: `Approved — added to research_kb` });
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
  cardAge: {
    fontSize: FontSize.xs,
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
