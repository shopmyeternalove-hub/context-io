-- =============================================================================
-- Context.io — Supabase schema
-- =============================================================================
-- Paste this into Supabase → SQL Editor → New query → Run.
-- Safe to re-run: every CREATE uses IF NOT EXISTS / OR REPLACE where possible.
--
-- Design notes
-- ------------
-- * auth.users(id) is the canonical user reference. We never store emails or
--   passwords in our own tables — Supabase Auth owns those.
--
-- * RLS is enabled on every table. The backend uses the service role key,
--   which bypasses RLS, so policies are only enforced when these tables are
--   queried with a user JWT (e.g. directly from the extension in the future).
--   Today we expose data through the backend, but the policies are in place
--   so we can later open direct client access without a security retrofit.
--
-- * usage_monthly uses a DATE column "month" set to the first day of each
--   month (e.g. 2026-05-01). Better than a string "2026-05" because it
--   indexes, sorts, and date-maths naturally.
--
-- * Atomic usage increment is exposed as the RPC increment_usage(user_id,
--   month, by). Always use it instead of SELECT+UPDATE from the backend to
--   avoid races when a user copies many phrases quickly.
--
-- * user_profiles is one-per-user for now (PRIMARY KEY on user_id). When
--   multiple profiles per user become a Pro feature, add a UUID PK and
--   migrate user_id from PK to a non-unique indexed FK.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Extensions
-- -----------------------------------------------------------------------------
create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "citext";     -- case-insensitive text


-- -----------------------------------------------------------------------------
-- Shared helper: updated_at trigger
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- =============================================================================
-- TABLE: user_profiles
-- =============================================================================
-- One profile per user (for now). Carries the user's professional context
-- and current plan. Plans:
--   "free" — default, subject to FREE_MONTHLY_LIMIT and FREE_MAX_CHARS
--   "pro"  — unlimited (or higher caps), can use meaning_rules
-- -----------------------------------------------------------------------------
create table if not exists public.user_profiles (
  user_id          uuid        primary key
                               references auth.users(id) on delete cascade,

  -- Professional context — these become the defaults for translate-context.
  profession       text        not null default '',
  source_language  text        not null default 'en',
  target_language  text        not null default 'en',
  tone             text        not null default 'natural-professional',
  output_format    text        not null default 'auto',

  -- Plan + billing-adjacent
  plan             text        not null default 'free'
                               check (plan in ('free', 'pro')),

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- updated_at trigger
drop trigger if exists trg_user_profiles_updated_at on public.user_profiles;
create trigger trg_user_profiles_updated_at
  before update on public.user_profiles
  for each row execute function public.set_updated_at();


-- =============================================================================
-- TABLE: usage_monthly
-- =============================================================================
-- One row per (user, month). "month" is always the first day of the month.
-- Use the increment_usage() function to update it; never UPDATE directly.
-- -----------------------------------------------------------------------------
create table if not exists public.usage_monthly (
  user_id      uuid        not null
                           references auth.users(id) on delete cascade,
  month        date        not null,
  used         integer     not null default 0 check (used >= 0),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  primary key (user_id, month)
);

-- Fast "current month for user" lookups (already covered by the PK in
-- most plans, but explicit index helps for range queries like "last 6 months").
create index if not exists idx_usage_monthly_user_month
  on public.usage_monthly (user_id, month desc);

-- updated_at trigger
drop trigger if exists trg_usage_monthly_updated_at on public.usage_monthly;
create trigger trg_usage_monthly_updated_at
  before update on public.usage_monthly
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- RPC: increment_usage(user_id, month, by)
-- -----------------------------------------------------------------------------
-- Atomically increments a user's monthly counter and returns the new total.
-- Inserts a row at zero if none exists yet for that month.
-- The backend should call this only AFTER a successful Claude response.
-- -----------------------------------------------------------------------------
create or replace function public.increment_usage(
  p_user_id uuid,
  p_month   date,
  p_by      integer default 1
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  new_used integer;
begin
  insert into public.usage_monthly (user_id, month, used)
  values (p_user_id, p_month, p_by)
  on conflict (user_id, month)
  do update set used = public.usage_monthly.used + excluded.used,
                updated_at = now()
  returning used into new_used;

  return new_used;
end;
$$;


-- =============================================================================
-- TABLE: meaning_rules
-- =============================================================================
-- Per-user terminology overrides. Used (in a future Pro release) to inject
-- "when this user says <term>, they mean <user_meaning>; prefer <preferred>,
-- avoid <avoid>" into the Claude prompt.
--
-- Indexed by lower(term) so the backend can do case-insensitive lookups
-- like "does this user have a rule for any word in the source text?"
-- -----------------------------------------------------------------------------
create table if not exists public.meaning_rules (
  id                     uuid        primary key default gen_random_uuid(),
  user_id                uuid        not null
                                     references auth.users(id) on delete cascade,

  term                   text        not null,
  user_meaning           text        not null default '',
  preferred_translation  text        not null default '',
  avoid_translation      text        not null default '',
  example_sentence       text        not null default '',
  notes                  text        not null default '',

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  -- A user can only have one rule per term (case-insensitive).
  unique (user_id, term)
);

-- Case-insensitive lookup index — supports "find a rule for this word".
create index if not exists idx_meaning_rules_user_term_lower
  on public.meaning_rules (user_id, lower(term));

-- updated_at trigger
drop trigger if exists trg_meaning_rules_updated_at on public.meaning_rules;
create trigger trg_meaning_rules_updated_at
  before update on public.meaning_rules
  for each row execute function public.set_updated_at();


-- =============================================================================
-- Row Level Security
-- =============================================================================
-- The backend uses the service role key which bypasses RLS. These policies
-- protect against accidental direct-client access with a user JWT (e.g. if
-- you later let the extension hit Supabase directly for settings UI).
-- =============================================================================

-- user_profiles
alter table public.user_profiles enable row level security;

drop policy if exists "users select own profile" on public.user_profiles;
create policy "users select own profile"
  on public.user_profiles for select
  using (auth.uid() = user_id);

drop policy if exists "users insert own profile" on public.user_profiles;
create policy "users insert own profile"
  on public.user_profiles for insert
  with check (auth.uid() = user_id);

drop policy if exists "users update own profile" on public.user_profiles;
create policy "users update own profile"
  on public.user_profiles for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "users delete own profile" on public.user_profiles;
create policy "users delete own profile"
  on public.user_profiles for delete
  using (auth.uid() = user_id);


-- usage_monthly — users may read their own usage but never write directly.
alter table public.usage_monthly enable row level security;

drop policy if exists "users select own usage" on public.usage_monthly;
create policy "users select own usage"
  on public.usage_monthly for select
  using (auth.uid() = user_id);
-- Note: no insert/update/delete policy for end users. The backend writes
-- exclusively through the increment_usage RPC using the service role.


-- meaning_rules
alter table public.meaning_rules enable row level security;

drop policy if exists "users select own rules" on public.meaning_rules;
create policy "users select own rules"
  on public.meaning_rules for select
  using (auth.uid() = user_id);

drop policy if exists "users insert own rules" on public.meaning_rules;
create policy "users insert own rules"
  on public.meaning_rules for insert
  with check (auth.uid() = user_id);

drop policy if exists "users update own rules" on public.meaning_rules;
create policy "users update own rules"
  on public.meaning_rules for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "users delete own rules" on public.meaning_rules;
create policy "users delete own rules"
  on public.meaning_rules for delete
  using (auth.uid() = user_id);


-- =============================================================================
-- Done. Verify with:
--   select table_name from information_schema.tables
--   where table_schema = 'public'
--     and table_name in ('user_profiles', 'usage_monthly', 'meaning_rules');
-- =============================================================================
