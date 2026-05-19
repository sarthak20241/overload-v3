-- 0022_agent_review_log.sql
--
-- Phase 3 final: auto-review agent at the 24h mark.
--
-- Every pending paper that has been waiting for 24+ hours gets a final
-- decision from a Sonnet-based review agent. The agent evaluates across
-- five dimensions (rigor, relevance, coherence, authority, novelty) and
-- commits to one of approve / reject / supersede / coexist.
--
-- Supersedes have code-enforced guardrails (in shared/agent-review.ts):
-- a meta-analysis can only be superseded by a meta-analysis/systematic-
-- review, preprints can't supersede peer-reviewed work, etc. When the
-- LLM picks a supersede that violates a guardrail, the action gets
-- downgraded to 'coexist' and the reason is logged.
--
-- Every decision lands in agent_review_log. Dashboard surfaces the last
-- N days for transparency. Each row has one-click revert via the
-- revert_agent_decision RPC — re-promotes the pending row to 'pending',
-- deletes the kb row created (which auto-un-supersedes via FK ON DELETE
-- SET NULL), so a bad call is one click away from being fixed.

create table if not exists agent_review_log (
  id                 uuid          primary key default uuid_generate_v4(),
  -- The pending row this decision was made about. We DON'T cascade on
  -- delete — even if the pending row is later deleted, the audit trail
  -- of what the agent decided should survive.
  pending_id         uuid          not null references research_kb_pending(id) on delete restrict,
  paper_url          text          not null,
  paper_title        text          not null,

  -- What the LLM wanted vs. what actually got applied. They diverge when
  -- a guardrail downgrades the action (typically supersede → coexist).
  proposed_action    text          not null check (proposed_action in ('approve','reject','supersede','coexist')),
  final_action       text          not null check (final_action    in ('approve','reject','supersede','coexist')),
  downgrade_reason   text,         -- null when proposed_action == final_action

  -- Agent's self-reported reasoning. confidence 0–1, flags is free-form
  -- short tokens like 'small_n', 'preprint', 'contradicts:<kb-id>'.
  rationale          text          not null,
  confidence         numeric(3,2)  not null default 0.5 check (confidence >= 0 and confidence <= 1),
  flags              text[]        not null default '{}',

  -- For supersede actions: which existing kb rows got marked superseded.
  -- Stored as ids so revert can find them via the superseded_by FK back-
  -- pointer (those rows had their superseded_by SET to new_kb_id).
  superseded_kb_ids  uuid[]        not null default '{}',
  -- The kb row promote_pending_to_kb created. Null for reject decisions.
  new_kb_id          uuid          references research_kb(id) on delete set null,

  agent_model        text          not null,
  decided_at         timestamptz   not null default now(),
  -- Full agent output for debugging / prompt-tuning later.
  raw_response       jsonb,

  -- Revert audit.
  reverted_at        timestamptz,
  reverted_by        text,
  revert_reason      text
);

-- One decision per pending row. Prevents the cron from re-reviewing the
-- same paper if a run is rerun. Excludes reverted decisions so a paper
-- can be re-reviewed after a revert (insert with reverted_at IS NULL
-- becomes possible again after the previous one is reverted).
create unique index if not exists idx_agent_review_log_unique_pending
  on agent_review_log (pending_id)
  where reverted_at is null;

-- Dashboard: "last N decisions" + "what's in flight" queries.
create index if not exists idx_agent_review_log_decided
  on agent_review_log (decided_at desc);

alter table agent_review_log enable row level security;

drop policy if exists "admin_read_agent_log" on agent_review_log;
create policy "admin_read_agent_log" on agent_review_log
  for select
  using (is_admin());

-- ── revert_agent_decision RPC ──────────────────────────────────────────────
-- Admin-only. Restores the pending row to 'pending' status, deletes the kb
-- row the agent created (which cascades superseded_by → null via the FK),
-- marks the log row reverted with audit fields.
create or replace function revert_agent_decision(
  p_log_id      uuid,
  p_reason      text default null,
  p_reverter    text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_log agent_review_log%ROWTYPE;
begin
  if not is_admin() then
    raise exception 'revert_agent_decision: caller is not an admin';
  end if;

  select * into v_log from agent_review_log where id = p_log_id;
  if not found then
    raise exception 'agent decision log % not found', p_log_id;
  end if;
  if v_log.reverted_at is not null then
    raise exception 'agent decision % already reverted at %', p_log_id, v_log.reverted_at;
  end if;

  -- Restore the pending row to fresh 'pending' so it shows up in the
  -- review queue again. Clears reviewed_at / reviewed_by / rejection_reason
  -- left by the original agent action.
  update research_kb_pending
  set review_status     = 'pending',
      reviewed_at       = null,
      reviewed_by       = null,
      rejection_reason  = null
  where id = v_log.pending_id;

  -- Delete the kb row the agent created. The superseded_by FK has
  -- ON DELETE SET NULL (migration 0021), so any rows that were superseded
  -- by this one automatically come back into retrieval.
  if v_log.new_kb_id is not null then
    -- Also clear superseded_at / superseded_by_reviewer on those rows for
    -- cleanliness — the FK only handles superseded_by itself.
    update research_kb
    set superseded_at = null,
        superseded_by_reviewer = null
    where id = any(v_log.superseded_kb_ids);

    delete from research_kb where id = v_log.new_kb_id;
  end if;

  update agent_review_log
  set reverted_at  = now(),
      reverted_by  = coalesce(p_reverter, auth.jwt()->>'sub'),
      revert_reason = p_reason
  where id = p_log_id;
end;
$$;
revoke all on function revert_agent_decision(uuid, text, text) from public;
grant execute on function revert_agent_decision(uuid, text, text) to authenticated;

-- ── Helper: pending papers ready for agent review ──────────────────────────
-- Returns rows older than the threshold with no live (un-reverted) agent
-- review log entry. The worker selects from here, then iterates.
create or replace function pending_ready_for_agent_review(
  p_age_hours integer default 24,
  p_limit     integer default 50
)
returns table (
  pending_id          uuid,
  title               text,
  url                 text,
  source              text,
  authors             text[],
  journal             text,
  pub_year            integer,
  topic_tags          text[],
  study_design        text,
  confidence          text,
  trust_score         numeric,
  population          text,
  intervention        text,
  key_finding         text,
  practical_takeaway  text,
  ingested_at         timestamptz,
  source_meta         jsonb,
  contradiction_flags jsonb,
  embedding           vector(1024)
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.id, p.title, p.url, p.source, p.authors, p.journal, p.pub_year,
    p.topic_tags, p.study_design, p.confidence, p.trust_score,
    p.population, p.intervention, p.key_finding, p.practical_takeaway,
    p.ingested_at, p.source_meta, p.contradiction_flags, p.embedding
  from research_kb_pending p
  where p.review_status = 'pending'
    and p.ingested_at <= now() - (p_age_hours || ' hours')::interval
    and not exists (
      select 1 from agent_review_log l
      where l.pending_id = p.id and l.reverted_at is null
    )
  order by p.ingested_at asc
  limit p_limit;
$$;
-- Service-role only — only the cron worker calls this.
revoke all on function pending_ready_for_agent_review(integer, integer) from public;
