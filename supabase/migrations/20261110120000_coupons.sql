-- Coupons: App Store offer codes kept for the admin site (admin/app/(admin)/coupons).
--
-- Apple only makes codes in groups: a batch of one-time codes is 500 to 25,000
-- codes, and a named code (like RAHUL) is good for 500+ uses. So the admin site
-- asks Apple for a batch, keeps every code here, and hands them out one by one.
-- Apple knows which codes were redeemed; this table knows which were handed out.
--
-- Admins only. The admin site reads and writes with the admin's Clerk token;
-- is_admin() (0019/0023) gates every row. No app user can see a code.

create table if not exists public.coupon_batches (
  id          text primary key,            -- Apple's id for the batch or named code
  period      text not null check (period in
                ('THREE_DAYS','ONE_WEEK','TWO_WEEKS','ONE_MONTH','TWO_MONTHS',
                 'THREE_MONTHS','SIX_MONTHS','ONE_YEAR')),
  offer_id    text not null,               -- Apple's offer code id
  kind        text not null check (kind in ('one_time','named')),
  count       integer not null,            -- codes in the batch, or uses of a named code
  expires     date,                        -- null: a named code with no end date
  status      text not null default 'making' check (status in ('making','ready','failed','off')),
                                           -- off: a named code turned off at Apple
  sandbox     boolean not null default false,
  error       text,
  created_by  text default (auth.jwt()->>'sub'),
  created_at  timestamptz not null default now()
);

create table if not exists public.coupons (
  code        text primary key,
  batch_id    text not null references public.coupon_batches(id),
  period      text not null,
  kind        text not null check (kind in ('one_time','named')),
  expires     date,
  sandbox     boolean not null default false,
  given_at    timestamptz,
  given_to    text,
  given_by    text,
  note        text,
  created_at  timestamptz not null default now()
);

create index if not exists coupons_unused_idx
  on public.coupons (period, sandbox, expires) where given_at is null;

-- Supabase grants every new public table to anon + authenticated. Take that
-- away first, then give admins only what the site needs.
revoke all on public.coupon_batches from anon, authenticated;
revoke all on public.coupons from anon, authenticated;
grant select, insert, update on public.coupon_batches to authenticated;
grant select, insert, update on public.coupons to authenticated;

alter table public.coupon_batches enable row level security;
alter table public.coupons enable row level security;

drop policy if exists coupon_batches_admin on public.coupon_batches;
create policy coupon_batches_admin on public.coupon_batches
  for all to authenticated using (is_admin()) with check (is_admin());

drop policy if exists coupons_admin on public.coupons;
create policy coupons_admin on public.coupons
  for all to authenticated using (is_admin()) with check (is_admin());

-- Hand out the next unused code for a period. One call, one code, never the
-- same code twice (row lock + skip locked). Oldest end date first, and never a
-- code that ends within 14 days. Null when none is left.
create or replace function public.give_coupon(
  p_period text,
  p_to text default null,
  p_note text default null,
  p_sandbox boolean default false
) returns public.coupons
language plpgsql
security invoker
set search_path = public
as $$
declare
  picked public.coupons;
begin
  -- is_admin() is null (not false) when the token has no role claim.
  if not coalesce(is_admin(), false) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  update public.coupons c
     set given_at = now(),
         given_to = nullif(trim(p_to), ''),
         given_by = auth.jwt()->>'sub',
         note     = nullif(trim(p_note), '')
   where c.code = (
     select code from public.coupons
      where period = p_period
        and kind = 'one_time'
        and sandbox = p_sandbox
        and given_at is null
        and expires >= current_date + 14
      order by expires, code
      limit 1
      for update skip locked
   )
  returning c.* into picked;
  return picked;
end;
$$;

revoke all on function public.give_coupon(text, text, text, boolean) from public, anon;
grant execute on function public.give_coupon(text, text, text, boolean) to authenticated;

-- Stock per period for the Coupons page (a read of the rows would stop at
-- PostgREST's 1,000-row cap). "usable" = unused one-time codes that last 14+ days.
create or replace function public.coupon_stock()
returns table (period text, sandbox boolean, usable bigint, ending_soon bigint, given bigint, next_end date)
language sql
stable
security invoker
set search_path = public
as $$
  select c.period, c.sandbox,
         count(*) filter (where c.kind = 'one_time' and c.given_at is null and c.expires >= current_date + 14),
         count(*) filter (where c.kind = 'one_time' and c.given_at is null and c.expires >= current_date
                            and c.expires < current_date + 14),
         count(*) filter (where c.given_at is not null),
         min(c.expires) filter (where c.kind = 'one_time' and c.given_at is null and c.expires >= current_date + 14)
    from public.coupons c
   where is_admin()
   group by c.period, c.sandbox;
$$;

revoke all on function public.coupon_stock() from public, anon;
grant execute on function public.coupon_stock() to authenticated;

notify pgrst, 'reload schema';
