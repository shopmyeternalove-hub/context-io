/*
 * src/routing.js
 * --------------
 * Backend-only model routing for /translate-context.
 *
 * The user never sees this. There is no UI for "Fast" vs "Deep". The
 * backend looks at the request and picks Haiku (fast, default) or Sonnet
 * (deep, only when the request is clearly heavier).
 *
 * Goal distribution: 85-95% fast, 5-15% deep.
 *
 * Pure function — no I/O, no Supabase, no Anthropic calls. Easy to test.
 *
 * Returns: { model, modelTier, routingReason, complexityScore }
 *   modelTier: "fast" | "deep"
 *   routingReason: short human-readable string for logs only
 *   complexityScore: integer, useful for tuning later
 */

"use strict";

const { config } = require("./config");

// Output formats that, on their own, push us toward Sonnet.
// "report" and "formal-document" are the heavy ones in this codebase
// (see anthropic.js FORMAT_DESCRIPTIONS). "client-update" stays on fast
// because it's tactical chat-adjacent writing.
const HEAVY_FORMATS = new Set([
  "report",
  "formal-document",
]);

// Profession keywords that, when present in the professional context,
// suggest dense terminology. Kept conservative — these are domains where
// the user explicitly signaled a heavy field. Case-insensitive substring
// match.
const HEAVY_PROFESSION_KEYWORDS = [
  "legal", "law", "attorney", "lawyer", "litigation", "contract",
  "medical", "medicine", "clinical", "doctor", "physician", "nurse",
  "financial", "finance", "banking", "investment", "accounting", "audit",
  "engineering", "technical documentation", "patent", "regulatory",
];

// Count ALL-CAPS tokens 2-6 chars long (acronyms like API, GDPR, FDA).
// Bounded scan; cheap.
function countAcronyms(s) {
  if (!s || typeof s !== "string") return 0;
  const matches = s.match(/\b[A-Z]{2,6}\b/g);
  return matches ? matches.length : 0;
}

function hasHeavyProfessionKeyword(profession) {
  if (!profession || typeof profession !== "string") return false;
  const p = profession.toLowerCase();
  return HEAVY_PROFESSION_KEYWORDS.some((kw) => p.includes(kw));
}

/**
 * @param {object} args
 * @param {string} args.userPlan         - "free" | "pro"
 * @param {string} args.text             - the source text being translated
 * @param {string} args.professionalProfile - profession + professional_context, merged
 * @param {Array}  args.meaningRules     - rows from meaning_rules (may be empty)
 * @param {string} args.outputFormat     - e.g. "chat", "email", "report", "formal-document"
 *
 * @returns {{ model:string, modelTier:"fast"|"deep", routingReason:string, complexityScore:number }}
 */
function chooseModelForTranslation({
  userPlan,        // accepted for future use; routing currently plan-agnostic
  text,
  professionalProfile,
  meaningRules,
  outputFormat,
}) {
  // Defensive coercion — caller may pass undefined.
  const t        = typeof text === "string" ? text : "";
  const profCtx  = typeof professionalProfile === "string" ? professionalProfile : "";
  const rules    = Array.isArray(meaningRules) ? meaningRules : [];
  const fmt      = typeof outputFormat === "string" ? outputFormat : "";

  const textLen        = t.length;
  const profCtxLen     = profCtx.length;
  const rulesCount     = rules.length;
  // Approximate combined "request weight" — text plus context plus a rough
  // estimate of the glossary block injected from meaning rules.
  const combinedLen    = textLen + profCtxLen + rulesCount * 120;
  const formatIsHeavy  = HEAVY_FORMATS.has(fmt);
  const acronymCount   = countAcronyms(t) + countAcronyms(profCtx);
  const heavyDomain    = hasHeavyProfessionKeyword(profCtx);

  // ----- Hard triggers — override everything else -----
  // Per spec: these flip to Sonnet regardless of score.
  if (textLen > 2500) {
    return finalize("deep", `text_length_over_2500 (${textLen})`, 999, fastModel(), deepModel());
  }
  if (rulesCount >= 8) {
    return finalize("deep", `meaning_rules_count_${rulesCount}`, 999, fastModel(), deepModel());
  }
  if (combinedLen > 5000) {
    return finalize("deep", `combined_size_over_5000 (${combinedLen})`, 999, fastModel(), deepModel());
  }
  if (formatIsHeavy) {
    return finalize("deep", `heavy_output_format_${fmt}`, 999, fastModel(), deepModel());
  }

  // ----- Combined-factor scoring -----
  let score = 0;
  const reasons = [];

  if (textLen > 1000)  { score += 10; reasons.push("text>1000"); }
  if (textLen > 1800)  { score += 15; reasons.push("text>1800"); }
  // textLen > 2500 was already a hard trigger above.

  if (rulesCount >= 3) { score += 10; reasons.push(`rules>=3(${rulesCount})`); }
  if (rulesCount >= 5) { score += 10; reasons.push("rules>=5"); }
  // rulesCount >= 8 was already a hard trigger.

  if (profCtxLen > 800)  { score += 10; reasons.push("profCtx>800"); }
  if (profCtxLen > 1500) { score += 15; reasons.push("profCtx>1500"); }

  // Acronym density — proxy for "many technical terms".
  if (acronymCount >= 3) { score += 10; reasons.push(`acronyms>=3(${acronymCount})`); }
  if (acronymCount >= 6) { score += 10; reasons.push("acronyms>=6"); }

  if (heavyDomain) { score += 15; reasons.push("heavy_profession_keyword"); }

  if (score >= 45) {
    return finalize("deep", `score=${score} [${reasons.join(",")}]`, score, fastModel(), deepModel());
  }

  return finalize("fast", `score=${score}${reasons.length ? ` [${reasons.join(",")}]` : ""}`, score, fastModel(), deepModel());
}

function finalize(tier, reason, score, fast, deep) {
  return {
    model:           tier === "deep" ? deep : fast,
    modelTier:       tier,
    routingReason:   reason,
    complexityScore: score,
  };
}

function fastModel() { return config.anthropic.fastModel; }
function deepModel() { return config.anthropic.deepModel; }

module.exports = { chooseModelForTranslation };
