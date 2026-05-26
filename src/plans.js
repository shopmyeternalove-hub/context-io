/*
 * src/plans.js
 * ------------
 * Single source of truth for plan-based features and limits.
 *
 * The backend uses this to:
 *   - decide whether to expose long-form professional_context to a user
 *   - decide whether to allow /meaning-rules CRUD
 *   - shape the /me response with a `features` object the portal reads
 *
 * The portal mirrors a subset of this in its own gating logic (so it can
 * grey out Pro-only UI), but the authoritative answer is always whatever
 * this module says.
 */

"use strict";

const { config } = require("./config");

const FREE = {
  name: "free",
  features: {
    basicProfile:      true,   // short profession + lang/tone/format (everyone)
    detailedProfile:   false,  // long-form professional_context
    meaningRules:      false,  // CRUD on /meaning-rules
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
  // "Unlimited" is modeled as MAX_SAFE_INTEGER internally so the existing
  // `used >= limit` check in /translate-context keeps working without a
  // special case. The /me response converts this to `null` for cleaner JSON.
  monthlyLimit:    Number.MAX_SAFE_INTEGER,
  maxChars:        config.limits.maxTextLength,
  maxProfiles:     5,
  maxMeaningRules: 200,
};

const PLANS = { free: FREE, pro: PRO };

function getPlan(planName) {
  return PLANS[planName] || FREE;
}

/**
 * Shape a raw user_profiles row into what the user's plan is allowed to see.
 * For Free users, long-form professional_context is hidden from the client
 * (it's still stored in the DB, so it reappears if they upgrade later).
 * Other fields are exposed to everyone.
 */
function shapeProfileForPlan(profile, planName) {
  if (!profile) return null;
  const plan = getPlan(planName);

  // Always-exposed fields.
  const out = {
    user_id:         profile.user_id,
    profile_name:    profile.profile_name    || "",
    profession:      profile.profession      || "",
    source_language: profile.source_language || "en",
    target_language: profile.target_language || "en",
    tone:            profile.tone            || "natural-professional",
    output_format:   profile.output_format   || "auto",
    plan:            profile.plan            || "free",
    created_at:      profile.created_at,
    updated_at:      profile.updated_at,
  };

  // Pro-only fields.
  if (plan.features.detailedProfile) {
    out.professional_context = profile.professional_context || "";
  }

  return out;
}

module.exports = { PLANS, getPlan, shapeProfileForPlan };
