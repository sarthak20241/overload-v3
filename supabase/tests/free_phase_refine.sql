-- Free refine turns on the free phase-1 build (20261031120000). A free user
-- may refine ONLY the phase they claimed the free build for, only while it is
-- still phase 1 of their active program with no saved routines, and at most 8
-- turns per account. Refine turns never spend build tries. Synthetic users
-- only; always rolled back.
begin;

do $$
declare
  pa uuid; pa1 uuid; pb uuid; pc uuid; prog_c uuid; pd uuid;
  r record; i integer; row_a public.free_phase_builds;
begin
  -- A: one active program, phase 1 (seq 0) and phase 2 (seq 1).
  insert into public.coach_programs(user_id) values ('refine_a') returning id into prog_c;
  insert into public.coach_program_phases(program_id,user_id,seq) values (prog_c,'refine_a',0) returning id into pa;
  insert into public.coach_program_phases(program_id,user_id,seq) values (prog_c,'refine_a',1) returning id into pa1;

  -- Unauthenticated.
  perform set_config('request.jwt.claims', '{}', true);
  select * into r from try_claim_free_phase_refine(pa);
  if r.allowed or r.reason <> 'unauthenticated' then raise exception 'no caller: got % %', r.allowed, r.reason; end if;

  perform set_config('request.jwt.claims', '{"sub":"refine_a"}', true);

  -- 1. No free build claimed yet: refine is not a way in.
  select * into r from try_claim_free_phase_refine(pa);
  if r.allowed or r.reason <> 'not_claimed' then raise exception 'refine before build: got % %', r.allowed, r.reason; end if;
  if exists (select 1 from public.free_phase_builds where user_id='refine_a') then
    raise exception 'a refused refine created a build row'; end if;

  select * into r from try_claim_free_phase_build(pa);
  if not r.allowed or r.reason <> 'claimed' then raise exception 'setup: build claim got % %', r.allowed, r.reason; end if;

  -- 2. Phase 2 of the same program is not the free build.
  select * into r from try_claim_free_phase_refine(pa1);
  if r.allowed or r.reason <> 'not_first_phase' then raise exception 'phase 2 refine: got % %', r.allowed, r.reason; end if;

  -- 3. Eight turns on the claimed draft, then no more.
  for i in 1..8 loop
    select * into r from try_claim_free_phase_refine(pa);
    if not r.allowed or r.reason <> 'refine' then raise exception 'turn %: got % %', i, r.allowed, r.reason; end if;
  end loop;
  select * into r from try_claim_free_phase_refine(pa);
  if r.allowed or r.reason <> 'turns_spent' then raise exception 'turn 9: got % %', r.allowed, r.reason; end if;
  select * into row_a from public.free_phase_builds where user_id='refine_a';
  if row_a.refine_turns <> 8 then raise exception 'refine_turns = %, want 8', row_a.refine_turns; end if;
  if row_a.attempts <> 1 then raise exception 'refine spent build tries: attempts = %', row_a.attempts; end if;

  -- 4. The build path is unchanged: a rebuild still has its tries.
  select * into r from try_claim_free_phase_build(pa);
  if not r.allowed or r.reason <> 'retry' then raise exception 'rebuild after refine: got % %', r.allowed, r.reason; end if;

  -- 5. B: refine works until the draft is saved, then stops.
  perform set_config('request.jwt.claims', '{"sub":"refine_b"}', true);
  insert into public.coach_programs(user_id) values ('refine_b') returning id into prog_c;
  insert into public.coach_program_phases(program_id,user_id,seq) values (prog_c,'refine_b',0) returning id into pb;
  select * into r from try_claim_free_phase_build(pb);
  if not r.allowed then raise exception 'setup: B build claim got % %', r.allowed, r.reason; end if;
  select * into r from try_claim_free_phase_refine(pb);
  if not r.allowed then raise exception 'B first refine: got % %', r.allowed, r.reason; end if;
  insert into public.routines(user_id,program_phase_id) values ('refine_b', pb);
  select * into r from try_claim_free_phase_refine(pb);
  if r.allowed or r.reason <> 'saved' then raise exception 'refine after save: got % %', r.allowed, r.reason; end if;
  if (select refine_turns from public.free_phase_builds where user_id='refine_b') <> 1 then
    raise exception 'a refused refine after save counted a turn'; end if;

  -- 6. C: the program ended, so its phase 1 is no longer the free draft.
  perform set_config('request.jwt.claims', '{"sub":"refine_c"}', true);
  insert into public.coach_programs(user_id) values ('refine_c') returning id into prog_c;
  insert into public.coach_program_phases(program_id,user_id,seq) values (prog_c,'refine_c',0) returning id into pc;
  select * into r from try_claim_free_phase_build(pc);
  if not r.allowed then raise exception 'setup: C build claim got % %', r.allowed, r.reason; end if;
  update public.coach_programs set status='ended' where id=prog_c;
  select * into r from try_claim_free_phase_refine(pc);
  if r.allowed or r.reason <> 'not_first_phase' then raise exception 'ended program refine: got % %', r.allowed, r.reason; end if;

  -- 7. D, with a claimed build of their own, cannot refine A's phase.
  perform set_config('request.jwt.claims', '{"sub":"refine_d"}', true);
  insert into public.coach_programs(user_id) values ('refine_d') returning id into prog_c;
  insert into public.coach_program_phases(program_id,user_id,seq) values (prog_c,'refine_d',0) returning id into pd;
  select * into r from try_claim_free_phase_build(pd);
  if not r.allowed then raise exception 'setup: D build claim got % %', r.allowed, r.reason; end if;
  select * into r from try_claim_free_phase_refine(pa);
  if r.allowed or r.reason <> 'not_first_phase' then raise exception 'D on A''s phase: got % %', r.allowed, r.reason; end if;

  -- 8. D's own phase 1 later becomes a different, unclaimed phase 1 (new
  --    program): refine follows the claimed phase only.
  update public.coach_programs set status='ended' where id=prog_c;
  insert into public.coach_programs(user_id) values ('refine_d') returning id into prog_c;
  insert into public.coach_program_phases(program_id,user_id,seq) values (prog_c,'refine_d',0) returning id into pd;
  select * into r from try_claim_free_phase_refine(pd);
  if r.allowed or r.reason <> 'not_claimed' then raise exception 'unclaimed new phase 1: got % %', r.allowed, r.reason; end if;

  -- 9. Grants: only signed-in users may call it.
  if has_function_privilege('anon', 'try_claim_free_phase_refine(uuid)', 'EXECUTE') then
    raise exception 'anon can execute try_claim_free_phase_refine'; end if;
  if not has_function_privilege('authenticated', 'try_claim_free_phase_refine(uuid)', 'EXECUTE') then
    raise exception 'authenticated cannot execute try_claim_free_phase_refine'; end if;
  if has_table_privilege('authenticated', 'public.free_phase_builds', 'SELECT') then
    raise exception 'free_phase_builds readable by clients'; end if;
end;
$$;
select 'refine needs a claimed build, phase 1 only, 8 turns then spent, no build tries spent, rebuild intact, stops on save, ended program, other user, new program, grants passed' as checks;
rollback;
