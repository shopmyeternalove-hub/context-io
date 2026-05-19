/*
 * src/supabase.js
 * ---------------
 * One module that owns:
 *   1. The Supabase admin client (uses the service role key — bypasses RLS).
 *   2. Token verification used by the auth middleware.
 *   3. Thin DB helpers for the three tables we added in schema.sql.
 *
 * Why "admin" client?
 *   The service role key has full DB access. We never expose it to the
 *   browser; it lives only in Render's environment. Calls made with this
 *   client bypass Row Level Security, which is exactly what we want for a
 *   trusted backend.
 *
 * Why a separate function to verify tokens?
 *   When a request arrives with `Authorization: Bearer <jwt>`, we call
 *   supabase.auth.getUser(jwt) using the admin client. Supabase verifies
 *   the JWT against its own signing key and returns the user record if it's
 *   valid. We don't try to validate JWTs ourselves.
 */

"use strict";

const { createClient } = require("@supabase/supabase-js");
const { config }       = require("./config");

// ---------- Client ----------
// Lazily constructed so this module loads even when Supabase env is missing
// (dev mode without auth). All helpers below null-guard on `client` and
// return graceful "no auth available" responses if Supabase isn't configured.
let client = null;

function getClient() {
  if (client) return client;
  if (!config.supabase.url || !config.supabase.serviceRoleKey) return null;

  client = createClient(
    config.supabase.url,
    config.supabase.serviceRoleKey,
    {
      auth: {
        // Server-side: never persist sessions, never auto-refresh.
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );
  return client;
}

function isEnabled() {
  return !!getClient();
}

// ---------- Token verification ----------
/**
 * Verify a Supabase access token (JWT). Returns the user object on success,
 * null if the token is missing/invalid/expired.
 */
async function verifyAccessToken(token) {
  if (!token) return null;
  const sb = getClient();
  if (!sb) return null;

  const { data, error } = await sb.auth.getUser(token);
  if (error || !data || !data.user) return null;
  return data.user; // { id, email, ... }
}

// ---------- Profile ----------
async function getProfile(userId) {
  const sb = getClient();
  if (!sb) return null;

  const { data, error } = await sb
    .from("user_profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw new Error(`profile read failed: ${error.message}`);
  return data; // null if no row yet
}

/**
 * Insert-or-update the user's profile. Allowed fields are whitelisted to
 * prevent a client from setting plan/created_at/etc.
 */
async function upsertProfile(userId, patch) {
  const sb = getClient();
  if (!sb) throw new Error("supabase disabled");

  const allowed = [
    "profession", "source_language", "target_language", "tone", "output_format",
  ];
  const row = { user_id: userId };
  for (const key of allowed) {
    if (patch[key] !== undefined && patch[key] !== null) {
      row[key] = patch[key];
    }
  }

  const { data, error } = await sb
    .from("user_profiles")
    .upsert(row, { onConflict: "user_id" })
    .select()
    .single();

  if (error) throw new Error(`profile upsert failed: ${error.message}`);
  return data;
}

// ---------- Usage ----------
/**
 * Returns the first day of the current month as an ISO date string
 * (e.g. "2026-05-01"). Used as the partition key in usage_monthly.
 */
function currentMonthKey(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

async function getMonthlyUsage(userId, monthKey = currentMonthKey()) {
  const sb = getClient();
  if (!sb) return 0;

  const { data, error } = await sb
    .from("usage_monthly")
    .select("used")
    .eq("user_id", userId)
    .eq("month", monthKey)
    .maybeSingle();

  if (error) throw new Error(`usage read failed: ${error.message}`);
  return (data && data.used) || 0;
}

/**
 * Atomic +1 (or +N) via the increment_usage Postgres function. Returns the
 * new total. Use this only after a successful Claude response.
 */
async function incrementUsage(userId, by = 1, monthKey = currentMonthKey()) {
  const sb = getClient();
  if (!sb) return 0;

  const { data, error } = await sb.rpc("increment_usage", {
    p_user_id: userId,
    p_month:   monthKey,
    p_by:      by,
  });
  if (error) throw new Error(`usage increment failed: ${error.message}`);
  return data || 0;
}

// ---------- Meaning rules (used in a future Pro release) ----------
async function listMeaningRules(userId) {
  const sb = getClient();
  if (!sb) return [];

  const { data, error } = await sb
    .from("meaning_rules")
    .select("*")
    .eq("user_id", userId)
    .order("term", { ascending: true });

  if (error) throw new Error(`rules read failed: ${error.message}`);
  return data || [];
}

module.exports = {
  isEnabled,
  verifyAccessToken,
  // profile
  getProfile,
  upsertProfile,
  // usage
  currentMonthKey,
  getMonthlyUsage,
  incrementUsage,
  // rules
  listMeaningRules,
};
