/*
 * src/supabase.js
 * ---------------
 * v3 — adds profession_profiles CRUD. The old "profile" concept now means
 * "the merged view of user_profiles + the user's active profession_profile".
 *
 * What changed vs v2:
 *   - getProfile() now JOINS user_profiles to its active profession_profile
 *     and returns a flat object that looks like the old shape, so existing
 *     callers don't break.
 *   - upsertProfile() splits its writes: global settings go to user_profiles,
 *     profession/professional_context/profile_name go to the active row in
 *     profession_profiles. If the user has no active profile yet, one is
 *     created.
 *   - New helpers for the /profiles endpoints:
 *       listProfessionProfiles, getProfessionProfile,
 *       createProfessionProfile, updateProfessionProfile,
 *       deleteProfessionProfile, activateProfessionProfile.
 */

"use strict";

const { createClient } = require("@supabase/supabase-js");
const { config }       = require("./config");

// ---------- Client ----------
let client = null;

function getClient() {
  if (client) return client;
  if (!config.supabase.url || !config.supabase.serviceRoleKey) return null;

  client = createClient(
    config.supabase.url,
    config.supabase.serviceRoleKey,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
  return client;
}

function isEnabled() {
  return !!getClient();
}

// ---------- Token verification ----------
async function verifyAccessToken(token) {
  if (!token) return null;
  const sb = getClient();
  if (!sb) return null;

  const { data, error } = await sb.auth.getUser(token);
  if (error || !data || !data.user) return null;
  return data.user;
}

// ---------- The "profile" view (user_profiles + active profession_profile) ----------
/**
 * Return the user's combined profile view: global settings from
 * user_profiles, merged with the active profession_profile's fields
 * (profile_name, profession, professional_context).
 *
 * Returns null if the user has no user_profiles row at all (brand new
 * sign-up before any profile write).
 *
 * Shape:
 *   {
 *     user_id, plan, source_language, target_language, tone, output_format,
 *     active_profile_id, created_at, updated_at,
 *     profile_name, profession, professional_context   // active prof profile (or "" if none)
 *   }
 */
async function getProfile(userId) {
  const sb = getClient();
  if (!sb) return null;

  const { data: userRow, error: userErr } = await sb
    .from("user_profiles")
    .select("user_id, plan, source_language, target_language, tone, output_format, active_profile_id, created_at, updated_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (userErr) throw new Error(`profile read failed: ${userErr.message}`);
  if (!userRow) return null;

  // Resolve active profession_profile.
  let activeProf = null;
  if (userRow.active_profile_id) {
    const { data: profRow, error: profErr } = await sb
      .from("profession_profiles")
      .select("id, profile_name, profession, professional_context")
      .eq("id",      userRow.active_profile_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (profErr) throw new Error(`active profession profile read failed: ${profErr.message}`);
    activeProf = profRow;
  }

  // If active_profile_id is missing or stale, fall back to any one of the
  // user's profession_profiles. This shouldn't happen after the migration,
  // but it's cheap insurance against orphaned state.
  if (!activeProf) {
    const { data: any, error: anyErr } = await sb
      .from("profession_profiles")
      .select("id, profile_name, profession, professional_context")
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (anyErr) throw new Error(`fallback profession profile read failed: ${anyErr.message}`);
    activeProf = any;
    // Heal user_profiles.active_profile_id if we found one.
    if (activeProf && !userRow.active_profile_id) {
      await sb.from("user_profiles")
        .update({ active_profile_id: activeProf.id })
        .eq("user_id", userId);
      userRow.active_profile_id = activeProf.id;
    }
  }

  return {
    user_id:           userRow.user_id,
    plan:              userRow.plan || "free",
    source_language:   userRow.source_language || "en",
    target_language:   userRow.target_language || "en",
    tone:              userRow.tone || "natural-professional",
    output_format:     userRow.output_format || "auto",
    active_profile_id: userRow.active_profile_id || null,
    created_at:        userRow.created_at,
    updated_at:        userRow.updated_at,
    profile_name:          activeProf ? (activeProf.profile_name || "")         : "",
    profession:            activeProf ? (activeProf.profession || "")           : "",
    professional_context:  activeProf ? (activeProf.professional_context || "") : "",
  };
}

/**
 * Upsert profile fields. The patch may contain a mix of:
 *
 *   GLOBAL (user_profiles):
 *     source_language, target_language, tone, output_format
 *
 *   ACTIVE PROFESSION PROFILE (profession_profiles, active row):
 *     profile_name, profession, professional_context
 *
 * Returns the same shape as getProfile() so the caller can hand the response
 * straight back to the client.
 *
 * Brand-new users (no user_profiles row yet) are handled: we create the
 * user_profiles row, create a "Profile 1" profession_profile, activate it,
 * then apply the patch.
 */
async function upsertProfile(userId, patch) {
  const sb = getClient();
  if (!sb) throw new Error("supabase disabled");

  // Partition the patch into global vs profession-profile fields.
  const GLOBAL_KEYS = ["source_language", "target_language", "tone", "output_format"];
  const PROF_KEYS   = ["profile_name", "profession", "professional_context"];

  const globalPatch = {};
  const profPatch   = {};
  for (const k of GLOBAL_KEYS) if (patch[k] !== undefined && patch[k] !== null) globalPatch[k] = patch[k];
  for (const k of PROF_KEYS)   if (patch[k] !== undefined && patch[k] !== null) profPatch[k]   = patch[k];

  // Ensure a user_profiles row exists. Use upsert so we can both create and
  // patch in one call.
  const userRow = { user_id: userId, ...globalPatch };
  const { error: upErr } = await sb
    .from("user_profiles")
    .upsert(userRow, { onConflict: "user_id" });
  if (upErr) throw new Error(`profile upsert (global) failed: ${upErr.message}`);

  // Now load the current state to find the active profession profile (or
  // create one if none exists yet).
  let { data: userNow, error: readErr } = await sb
    .from("user_profiles")
    .select("active_profile_id")
    .eq("user_id", userId)
    .single();
  if (readErr) throw new Error(`profile reload failed: ${readErr.message}`);

  let activeId = userNow.active_profile_id;

  if (!activeId) {
    // No active profile yet — try to find any existing one or create one.
    const { data: existing } = await sb
      .from("profession_profiles")
      .select("id")
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (existing) {
      activeId = existing.id;
    } else {
      // Brand new user — create a starter profession profile.
      const { data: created, error: cErr } = await sb
        .from("profession_profiles")
        .insert({
          user_id:      userId,
          profile_name: "Profile 1",
        })
        .select("id")
        .single();
      if (cErr) throw new Error(`starter profession profile create failed: ${cErr.message}`);
      activeId = created.id;
    }

    await sb.from("user_profiles")
      .update({ active_profile_id: activeId })
      .eq("user_id", userId);
  }

  // Apply profession-profile patch (if any) to the active row.
  if (Object.keys(profPatch).length > 0) {
    const { error: ppErr } = await sb
      .from("profession_profiles")
      .update(profPatch)
      .eq("id",      activeId)
      .eq("user_id", userId);
    if (ppErr) throw new Error(`active profession profile update failed: ${ppErr.message}`);
  }

  return getProfile(userId);
}

// ---------- Profession profiles (multi-profile) ----------

async function listProfessionProfiles(userId) {
  const sb = getClient();
  if (!sb) return [];

  const { data, error } = await sb
    .from("profession_profiles")
    .select("id, profile_name, profession, professional_context, created_at, updated_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`profession profiles list failed: ${error.message}`);
  return data || [];
}

async function getProfessionProfile(userId, id) {
  const sb = getClient();
  if (!sb) return null;

  const { data, error } = await sb
    .from("profession_profiles")
    .select("*")
    .eq("id",      id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`profession profile read failed: ${error.message}`);
  return data;
}

/**
 * Create a new profession profile for the user. Caller is expected to pass
 * a non-empty profile_name (gated upstream by validation).
 */
async function createProfessionProfile(userId, patch) {
  const sb = getClient();
  if (!sb) throw new Error("supabase disabled");

  const row = {
    user_id:              userId,
    profile_name:         patch.profile_name,
    profession:           patch.profession           || "",
    professional_context: patch.professional_context || "",
  };
  const { data, error } = await sb
    .from("profession_profiles")
    .insert(row)
    .select()
    .single();
  if (error) throw new Error(`profession profile create failed: ${error.message}`);
  return data;
}

async function updateProfessionProfile(userId, id, patch) {
  const sb = getClient();
  if (!sb) throw new Error("supabase disabled");

  const allowed = ["profile_name", "profession", "professional_context"];
  const row = {};
  for (const k of allowed) if (patch[k] !== undefined && patch[k] !== null) row[k] = patch[k];

  const { data, error } = await sb
    .from("profession_profiles")
    .update(row)
    .eq("id",      id)
    .eq("user_id", userId)
    .select()
    .maybeSingle();
  if (error) throw new Error(`profession profile update failed: ${error.message}`);
  return data;
}

/**
 * Delete a profession profile. The caller must check that the requested id
 * is NOT currently active — that's enforced at the route layer so the route
 * can return a friendlier 409 with the active id.
 *
 * Returns the number of rows deleted (0 if id didn't match or wrong user).
 */
async function deleteProfessionProfile(userId, id) {
  const sb = getClient();
  if (!sb) throw new Error("supabase disabled");

  const { error, count } = await sb
    .from("profession_profiles")
    .delete({ count: "exact" })
    .eq("id",      id)
    .eq("user_id", userId);
  if (error) throw new Error(`profession profile delete failed: ${error.message}`);
  return count || 0;
}

/**
 * Set the user's active profession profile. Verifies the target row belongs
 * to this user before flipping the pointer. Returns true on success.
 */
async function activateProfessionProfile(userId, id) {
  const sb = getClient();
  if (!sb) throw new Error("supabase disabled");

  // Ownership check.
  const { data: owned, error: oErr } = await sb
    .from("profession_profiles")
    .select("id")
    .eq("id",      id)
    .eq("user_id", userId)
    .maybeSingle();
  if (oErr)    throw new Error(`profession profile ownership check failed: ${oErr.message}`);
  if (!owned)  return false;

  const { error: uErr } = await sb
    .from("user_profiles")
    .update({ active_profile_id: id })
    .eq("user_id", userId);
  if (uErr) throw new Error(`active profile update failed: ${uErr.message}`);
  return true;
}

async function countProfessionProfiles(userId) {
  const sb = getClient();
  if (!sb) return 0;

  const { count, error } = await sb
    .from("profession_profiles")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId);
  if (error) throw new Error(`profession profiles count failed: ${error.message}`);
  return count || 0;
}

// ---------- Usage ----------
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

// ---------- Meaning rules (Pro) — unchanged from v2 ----------
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

async function createMeaningRule(userId, patch) {
  const sb = getClient();
  if (!sb) throw new Error("supabase disabled");

  const row = {
    user_id:               userId,
    term:                  patch.term,
    user_meaning:          patch.user_meaning          || "",
    preferred_translation: patch.preferred_translation || "",
    avoid_translation:     patch.avoid_translation     || "",
    example_sentence:      patch.example_sentence      || "",
    notes:                 patch.notes                 || "",
  };
  const { data, error } = await sb
    .from("meaning_rules")
    .insert(row)
    .select()
    .single();
  if (error) throw new Error(`rule create failed: ${error.message}`);
  return data;
}

async function updateMeaningRule(userId, ruleId, patch) {
  const sb = getClient();
  if (!sb) throw new Error("supabase disabled");

  const allowed = ["term", "user_meaning", "preferred_translation", "avoid_translation", "example_sentence", "notes"];
  const row = {};
  for (const key of allowed) {
    if (patch[key] !== undefined && patch[key] !== null) row[key] = patch[key];
  }
  const { data, error } = await sb
    .from("meaning_rules")
    .update(row)
    .eq("id",      ruleId)
    .eq("user_id", userId)
    .select()
    .maybeSingle();
  if (error) throw new Error(`rule update failed: ${error.message}`);
  return data;
}

async function deleteMeaningRule(userId, ruleId) {
  const sb = getClient();
  if (!sb) throw new Error("supabase disabled");

  const { error, count } = await sb
    .from("meaning_rules")
    .delete({ count: "exact" })
    .eq("id",      ruleId)
    .eq("user_id", userId);
  if (error) throw new Error(`rule delete failed: ${error.message}`);
  return count || 0;
}

module.exports = {
  isEnabled,
  verifyAccessToken,
  // combined profile view + writes
  getProfile,
  upsertProfile,
  // profession profiles (multi-profile)
  listProfessionProfiles,
  getProfessionProfile,
  createProfessionProfile,
  updateProfessionProfile,
  deleteProfessionProfile,
  activateProfessionProfile,
  countProfessionProfiles,
  // usage
  currentMonthKey,
  getMonthlyUsage,
  incrementUsage,
  // meaning rules
  listMeaningRules,
  createMeaningRule,
  updateMeaningRule,
  deleteMeaningRule,
};
