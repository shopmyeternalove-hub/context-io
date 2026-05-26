-- =============================================================================
-- Context.io — Migration 003b: drop legacy profile columns
-- =============================================================================
-- Run this AFTER:
--   1. Migration 003a has been run
--   2. The v3 backend has been deployed AND verified healthy in production
--      (test /me, /profile, /translate-context, /profiles all returning 200)
--
-- This removes the columns that profession_profiles now owns. Doing it
-- prematurely will crash the v2 backend; doing it eventually is just hygiene.
-- After this runs, there is no going back to v2 without restoring data.
--
-- Idempotent: each DROP uses IF EXISTS.
-- =============================================================================

alter table public.user_profiles drop column if exists profession;
alter table public.user_profiles drop column if exists professional_context;
alter table public.user_profiles drop column if exists profile_name;

-- The constraints attached to those columns vanish with the columns, but in
-- case any explicit named constraints remain from migration 002:
alter table public.user_profiles
  drop constraint if exists user_profiles_professional_context_len;
alter table public.user_profiles
  drop constraint if exists user_profiles_profile_name_len;

-- =============================================================================
-- Verify:
--   select column_name from information_schema.columns
--    where table_schema='public' and table_name='user_profiles'
--    order by column_name;
--   (should NOT contain profession, professional_context, profile_name)
-- =============================================================================
