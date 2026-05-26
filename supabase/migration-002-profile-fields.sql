-- =============================================================================
-- Context.io — Migration 002: profile fields
-- =============================================================================
-- Adds two columns to user_profiles that the v2 backend writes:
--
--   profile_name           — short user-chosen label, all plans (e.g. "Google Ads")
--   professional_context   — long-form professional context, Pro only
--
-- Safe to re-run: each ALTER uses IF NOT EXISTS.
--
-- Run this in Supabase → SQL Editor → New query → Run BEFORE deploying the
-- v2 backend. The new code writes these columns on profile saves; without
-- the columns, those writes will fail with "column does not exist".
-- =============================================================================

alter table public.user_profiles
  add column if not exists profile_name         text not null default '';

alter table public.user_profiles
  add column if not exists professional_context text not null default '';

-- Cap the long-form field at the DB level too. 2000 chars is what the
-- portal and backend both enforce; this stops anything sneaky from
-- inserting more than that directly through the service role.
-- (Drop + recreate constraint so this is idempotent.)
alter table public.user_profiles
  drop constraint if exists user_profiles_professional_context_len;
alter table public.user_profiles
  add  constraint user_profiles_professional_context_len
       check (char_length(professional_context) <= 2000);

alter table public.user_profiles
  drop constraint if exists user_profiles_profile_name_len;
alter table public.user_profiles
  add  constraint user_profiles_profile_name_len
       check (char_length(profile_name) <= 60);

-- =============================================================================
-- Verify the new columns exist:
--   select column_name, data_type, column_default
--   from information_schema.columns
--   where table_schema = 'public'
--     and table_name = 'user_profiles'
--     and column_name in ('profile_name', 'professional_context');
-- =============================================================================
