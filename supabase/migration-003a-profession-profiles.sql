-- =============================================================================
-- Context.io — Migration 003a: profession profiles (forward-compatible phase)
-- =============================================================================
-- This is the SAFE half of the multi-profile migration. It creates the new
-- table, copies data, and adds the active_profile_id pointer — but it does
-- NOT drop the old profession / professional_context / profile_name columns
-- from user_profiles. After this migration:
--
--   - The running v2 backend keeps working (it reads the old columns, which
--     are still there and still up to date).
--   - The v3 backend ALSO works (it reads from profession_profiles via the
--     active_profile_id pointer).
--
-- Run order:
--   1. Run THIS migration (003a) in Supabase SQL Editor.
--   2. Verify with the queries at the bottom.
--   3. Push v3 backend to GitHub → Render auto-deploys.
--   4. Verify v3 is healthy in production.
--   5. Run migration-003b-drop-legacy-columns.sql to drop the old columns.
--
-- Step 5 is optional and can wait days/weeks — the legacy columns just sit
-- there unused. Doing it eventually is good hygiene; doing it prematurely
-- could break a v2 instance you forgot was still running.
--
-- Idempotent: re-running is safe.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Create profession_profiles
-- -----------------------------------------------------------------------------
create table if not exists public.profession_profiles (
  id                     uuid        primary key default gen_random_uuid(),
  user_id                uuid        not null
                                     references auth.users(id) on delete cascade,

  profile_name           text        not null,
  profession             text        not null default '',
  professional_context   text        not null default '',

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint profession_profiles_name_len      check (char_length(profile_name)         <= 60),
  constraint profession_profiles_prof_len      check (char_length(profession)           <= 120),
  constraint profession_profiles_ctx_len       check (char_length(professional_context) <= 2000),
  constraint profession_profiles_name_nonblank check (char_length(trim(profile_name)) > 0)
);

create index if not exists idx_profession_profiles_user
  on public.profession_profiles (user_id);

-- updated_at trigger (reuses set_updated_at() from schema.sql)
drop trigger if exists trg_profession_profiles_updated_at on public.profession_profiles;
create trigger trg_profession_profiles_updated_at
  before update on public.profession_profiles
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- 2. Copy existing data
-- -----------------------------------------------------------------------------
-- For every user_profiles row that doesn't already have a corresponding
-- profession_profile, create one named "Profile 1" carrying their current
-- profession + professional_context.
-- -----------------------------------------------------------------------------
insert into public.profession_profiles (user_id, profile_name, profession, professional_context)
select
  up.user_id,
  'Profile 1',
  coalesce(up.profession, ''),
  coalesce(up.professional_context, '')
from public.user_profiles up
where not exists (
  select 1 from public.profession_profiles pp where pp.user_id = up.user_id
);


-- -----------------------------------------------------------------------------
-- 3. Add active_profile_id to user_profiles (nullable for now)
-- -----------------------------------------------------------------------------
alter table public.user_profiles
  add column if not exists active_profile_id uuid
    references public.profession_profiles(id) on delete set null;


-- -----------------------------------------------------------------------------
-- 4. Backfill active_profile_id
-- -----------------------------------------------------------------------------
update public.user_profiles up
   set active_profile_id = pp.id
  from public.profession_profiles pp
 where pp.user_id          = up.user_id
   and up.active_profile_id is null;


-- -----------------------------------------------------------------------------
-- 5. Row Level Security on profession_profiles
-- -----------------------------------------------------------------------------
alter table public.profession_profiles enable row level security;

drop policy if exists "users select own profession profiles" on public.profession_profiles;
create policy "users select own profession profiles"
  on public.profession_profiles for select
  using (auth.uid() = user_id);

drop policy if exists "users insert own profession profiles" on public.profession_profiles;
create policy "users insert own profession profiles"
  on public.profession_profiles for insert
  with check (auth.uid() = user_id);

drop policy if exists "users update own profession profiles" on public.profession_profiles;
create policy "users update own profession profiles"
  on public.profession_profiles for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "users delete own profession profiles" on public.profession_profiles;
create policy "users delete own profession profiles"
  on public.profession_profiles for delete
  using (auth.uid() = user_id);


-- =============================================================================
-- Verify (run each as a separate query):
--
-- A) Every user has exactly one profession profile (post-migration baseline):
--      select user_id, count(*) as n
--        from public.profession_profiles
--       group by user_id
--       order by n desc;
--
-- B) Every user's active_profile_id points at a valid row:
--      select up.user_id, up.active_profile_id, pp.profile_name, pp.profession
--        from public.user_profiles up
--        left join public.profession_profiles pp on pp.id = up.active_profile_id;
--
-- C) The legacy columns are still present (expected during 003a):
--      select column_name from information_schema.columns
--       where table_schema='public' and table_name='user_profiles'
--         and column_name in ('profession','professional_context','profile_name');
-- =============================================================================
