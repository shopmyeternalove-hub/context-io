/*
 * src/plans.js
 * ------------
 * Single source of truth for plan-based features and limits.
 *
 * v3 changes:
 *   - Pro.maxProfiles is now Infinity (unlimited profession profiles).
 *   - shapeProfileForPlan operates on the COMBINED shape returned by
 *     supabase.getProfile() in v3: global settings from user_profiles +
 *     fields from the active profession_profiles row.
 */

"use strict";

const { config } = require("./config");

const FREE = {
  name: "free",
  features: {
    basicProfile:      true,
    detailedProfile:   false,
    meaningRules:      false,
    multipleProfiles:  false,
    savedTerminology:  false,
  },
  monthlyLimit:    config.freeTier.monthlyLimit,
  maxChars:        config.freeTier.maxChars,
  maxProfiles:     1,
  maxMeaningRules: 0,
};

const PRO = {
  name: "pro",
  features: {
    basicProfile:      true,
    detailedProfile:   true,
    meaningRules:      true,
    multipleProfiles:  true,
    savedTerminology:  true,
  },
  monthlyLimit:    Number.MAX_SAFE_INTEGER,
  maxChars:        config.limits.maxTextLength,
  maxProfiles:     Number.POSITIVE_INFINITY,  // unlimited on Pro
  maxMeaningRules: 200,
};

const PLANS = { free: FREE, pro: PRO };

function getPlan(planName) {
  return PLANS[planName] || FREE;
}

/**
 * Shape the combined user-profile-view (returned by supabase.getProfile)
 * into what the user's plan is allowed to see.
 *
 * Input `profile` is the merged shape from supabase.getProfile in v3:
 *   {
 *     user_id, plan, source_language, target_language, tone, output_format,
 *     active_profile_id, created_at, updated_at,
 *     profile_name, profession, professional_context  // from active profession_profile
 *   }
 *
 * For Free users, long-form professional_context is hidden from the
 * response (still stored — if they upgrade, it reappears).
 */
function shapeProfileForPlan(profile, planName) {
  if (!profile) return null;
  const plan = getPlan(planName);

  const out = {
    user_id:           profile.user_id,
    active_profile_id: profile.active_profile_id || null,
    profile_name:      profile.profile_name      || "",
    profession:        profile.profession        || "",
    source_language:   profile.source_language   || "en",
    target_language:   profile.target_language   || "en",
    tone:              profile.tone              || "natural-professional",
    output_format:     profile.output_format     || "auto",
    plan:              profile.plan              || "free",
    created_at:        profile.created_at,
    updated_at:        profile.updated_at,
  };

  if (plan.features.detailedProfile) {
    out.professional_context = profile.professional_context || "";
  }

  return out;
}

module.exports = { PLANS, getPlan, shapeProfileForPlan };
