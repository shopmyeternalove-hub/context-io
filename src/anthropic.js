/*
 * src/anthropic.js
 * ----------------
 * Thin wrapper around the Anthropic SDK for the one task this backend does:
 * professional-context translation.
 *
 * Two responsibilities:
 *   1. Build the system + user prompt that asks Claude for STRICT JSON with
 *      the four fields the Chrome extension expects.
 *   2. Call the Messages API, parse the JSON, and normalize the shape.
 *
 * The Anthropic API key is read from config (which reads it from .env).
 * It is NEVER returned to the client.
 */

"use strict";

const Anthropic = require("@anthropic-ai/sdk").default;
const { config } = require("./config");

// Lazily construct the client so tests can mock if needed.
let client = null;
function getClient() {
  if (!client) {
    client = new Anthropic({ apiKey: config.anthropic.apiKey });
  }
  return client;
}

// Human-readable language names. Claude understands codes, but giving it the
// full name makes the output more reliable, especially for less common pairs.
const LANG_NAMES = {
  auto: "auto-detect",
  en: "English", es: "Spanish", fr: "French", de: "German",
  it: "Italian", pt: "Portuguese", ar: "Arabic", he: "Hebrew",
  zh: "Chinese", ja: "Japanese", ko: "Korean", ru: "Russian",
  hi: "Hindi", tr: "Turkish", nl: "Dutch", pl: "Polish", sv: "Swedish",
};

function langName(code) {
  return LANG_NAMES[code] || code;
}

// System prompt: this is where we lock in the *role* and the JSON contract.
// We keep it short. Anthropic guidance: be explicit about output format and
// give one tight example.
const SYSTEM_PROMPT = `You are Context.io, a professional-context translator.

You are NOT a generic translator. Your job is to preserve the professional
meaning of a phrase as a domain expert would understand it — not the literal
word-for-word translation. Use the user's profession/domain as the lens for
interpretation. If the user has no profession set, fall back to careful
general-purpose translation.

Three independent axes shape the output:
  1. profession — controls MEANING. The lens for interpreting domain terms.
  2. outputFormat — controls WRITING STYLE AND STRUCTURE. Where the
     translation will be pasted (chat message, email, report, etc.).
  3. tone — controls ATTITUDE AND POLISH (natural-professional, formal,
     conversational, executive, plain, etc.).

MEANING LOCK — the contextTranslation may freely change wording, sentence
structure, idioms, and length to fit outputFormat and tone, but it MUST NOT
change any of these:
  - The professional/domain meaning of every term.
  - The certainty level (do not soften "will" to "might", do not harden
    "may" to "will").
  - The risk level or severity (do not downgrade a warning, do not upgrade
    a routine note).
  - The intent of the original (request, statement, question, instruction,
    apology — preserved as-is).
  - Any domain-specific implications a professional would read into the
    phrasing.

You ALWAYS respond with a single JSON object and nothing else. No prose
outside the JSON, no markdown fences, no explanation. The JSON must contain
exactly these keys:

{
  "professionalMeaning": string,   // What the source phrase actually means in the user's professional domain. 1-2 sentences.
  "contextTranslation":  string,   // The translation into the target language, written for the requested outputFormat and tone, while preserving the meaning-lock rules above.
  "genericMistake":      string,   // The most likely mistranslation a generic translator (Google Translate / a non-specialist) would produce, and why it's wrong in this domain. 1-2 sentences. Empty string if there is no notable risk of mistranslation.
  "keyTerms": [                    // Up to 5 domain-specific terms from the source, with their professional equivalents in the target language. Empty array if none.
    { "term": string, "translation": string, "note": string }
  ]
}

Rules:
- Output valid JSON. No trailing commas. No comments. No code fences.
- Strings must be plain text (no markdown).
- "note" in keyTerms is optional context (≤ 12 words) — use "" if not needed.
- If source language is "auto-detect", detect it silently; do not mention detection in the output.
- The "contextTranslation" field MUST visibly reflect the requested outputFormat AND tone. Same source text with different outputFormat or tone must produce noticeably different translations — different word choices, register, structure — BUT identical meaning.
- The other fields (professionalMeaning, genericMistake, keyTerms) stay neutral and explanatory regardless of tone/outputFormat.`;

// Concrete behavior for each tone. Claude responds much more consistently
// when each tone has explicit stylistic guidance than when it just sees
// the label.
const TONE_DESCRIPTIONS = {
  "natural-professional": "Natural professional register. Sounds like a real domain professional speaking or writing in context — fluent, unforced, contextually appropriate. Not stiff, not casual — just how a competent professional would phrase it. This is the default when no other tone is specifically warranted.",
  professional:   "Polished business register. Industry-standard terminology, no slang, no casualisms. The way a domain professional would write in a work context — confident, direct, jargon used precisely.",
  formal:         "Highly formal register. Full sentences, no contractions, respectful and reserved. Suitable for official correspondence, legal, or diplomatic contexts.",
  neutral:        "Default register. Neither casual nor formal. Plain professional prose without stylistic emphasis.",
  conversational: "Natural spoken-style register. Contractions, everyday phrasing, friendly. Like a colleague chatting in Slack — still accurate, but relaxed.",
  academic:       "Scholarly register. Precise, careful, hedged where appropriate. Field-specific terminology preserved. Suitable for papers or research notes.",
  executive:      "Senior-business register. Crisp, outcome-oriented, action-focused. Short sentences, decision-ready phrasing. Suitable for board memos or executive summaries.",
  plain:          "Plain-language register. Simplest accurate phrasing. Avoid jargon; if a domain term must appear, gloss it briefly. Suitable for a non-specialist audience.",
};

function toneDescription(t) {
  return TONE_DESCRIPTIONS[t] || TONE_DESCRIPTIONS["natural-professional"];
}

// Writing-style / structural guidance per output format. This is where the
// translation gets adapted to the surface it will be pasted into.
const FORMAT_DESCRIPTIONS = {
  chat: "Chat message (WhatsApp, Slack, iMessage). Sound like a real person typing to a colleague. Short. Direct. Contractions are fine. No greetings, sign-offs, or formal salutations. One or two sentences usually; longer only if the source requires it. Still professionally accurate — chat-casual register, not joke-casual.",
  email: "Email body, suitable for a colleague or client. Polished and clear. Complete sentences, properly punctuated. May open with a brief contextual clause if the source implies one, but no greeting or sign-off (those are added separately by the user). Slightly more structured than chat, more relaxed than a report.",
  "client-update": "Client-facing status update. Clear, tactful, and constructive. If the source reports an issue or bad news, you MUST NOT hide it or soften the meaning — but you MAY phrase it constructively: lead with what is known, frame next steps positively, avoid blame language. Diplomatic without being evasive. Severity and certainty are preserved exactly.",
  report: "Document/report-ready prose. Formal, structured, full sentences. Third-person where natural. No contractions. Suitable for pasting into a written report, a Google Doc, or a written deliverable. Slightly more verbose and precise than email register.",
  "technical-note": "Compact technical note. Precise, terse, dense with accurate domain terms. Imperative or telegraphic where natural. Suitable for code comments, runbooks, JIRA tickets, or engineering notes. No filler words, no rhetorical softening.",
  "formal-document": "Highly formal document register (contract, legal memo, official letter). Maximum precision over naturalness. Full formal phrasing, conservative terminology, no contractions, no casualisms. When in doubt, choose the more careful and exact word.",
};

function formatDescription(f) {
  // "auto" should never reach this code path — the extension resolves it
  // before sending — but if it does, fall back to natural professional.
  if (f === "auto" || !FORMAT_DESCRIPTIONS[f]) {
    return "Natural professional writing, neither chat-casual nor formally rigid. Default fallback.";
  }
  return FORMAT_DESCRIPTIONS[f];
}

/**
 * Build the user-turn content for a given request.
 */
function formatRulesBlock(rules) {
  if (!Array.isArray(rules) || rules.length === 0) return [];

  const lines = [
    `DOMAIN GLOSSARY (highest priority — these override generic translation):`,
    `The user has defined the following terms from their professional world.`,
    `When any of these terms appear in the source text, you MUST preserve the`,
    `user's meaning, use the preferred translation, and avoid the listed`,
    `incorrect renderings. Reflect rule adherence in keyTerms when relevant.`,
    ``,
  ];

  for (const r of rules) {
    if (!r || !r.term) continue;
    lines.push(`- Term: "${r.term}"`);
    if (r.user_meaning)          lines.push(`  Means: ${r.user_meaning}`);
    if (r.preferred_translation) lines.push(`  Preferred translation: ${r.preferred_translation}`);
    if (r.avoid_translation)     lines.push(`  Avoid: ${r.avoid_translation}`);
    if (r.example_sentence)      lines.push(`  Example: "${r.example_sentence}"`);
    if (r.notes)                 lines.push(`  Notes: ${r.notes}`);
  }

  lines.push(``);
  return lines;
}

function buildUserMessage({ text, profession, sourceLanguage, targetLanguage, tone, outputFormat }, { meaningRules = [] } = {}) {
  const professionLine = profession
    ? `Profession / domain (controls MEANING): ${profession}`
    : `Profession / domain: (not specified — use careful general-purpose translation)`;

  return [
    professionLine,
    `Source language: ${langName(sourceLanguage)}`,
    `Target language: ${langName(targetLanguage)}`,
    ``,
    `OUTPUT FORMAT (controls WRITING STYLE AND STRUCTURE): ${outputFormat}`,
    `Format guidance: ${formatDescription(outputFormat)}`,
    ``,
    `TONE (controls ATTITUDE AND POLISH): ${tone}`,
    `Tone guidance: ${toneDescription(tone)}`,
    ``,
    ...formatRulesBlock(meaningRules),
    `The "contextTranslation" field MUST reflect both the outputFormat and the tone, while preserving the exact professional meaning, certainty, risk level, intent, and domain implications of the source. The other fields (professionalMeaning, genericMistake, keyTerms) stay neutral and explanatory.`,
    ``,
    `Source text:`,
    `"""`,
    text,
    `"""`,
    ``,
    `Return the JSON object now.`,
  ].join("\n");
}

/**
 * Extract a JSON object from a model response.
 * Claude is well-behaved with strict JSON instructions, but we still defend
 * against a stray code fence or leading prose.
 */
function extractJson(raw) {
  if (typeof raw !== "string") {
    throw new Error("Model response was not text.");
  }
  let s = raw.trim();

  // Strip ```json ... ``` or ``` ... ``` fences if present.
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  }

  // If there's still leading prose, slice from first { to last }.
  const first = s.indexOf("{");
  const last  = s.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) {
    throw new Error("Model did not return a JSON object.");
  }
  const candidate = s.slice(first, last + 1);

  return JSON.parse(candidate);
}

/**
 * Normalize Claude's parsed JSON into the exact shape the extension expects.
 * Defensive against missing or extra fields.
 */
function normalize(parsed, { meaningRules = [] } = {}) {
  const safe = (v) => (typeof v === "string" ? v.trim() : "");

  // Build a lowercased lookup of rule terms for fast matching.
  const ruleTerms = (Array.isArray(meaningRules) ? meaningRules : [])
    .map((r) => (r && typeof r.term === "string" ? r.term.trim().toLowerCase() : ""))
    .filter(Boolean);

  // A keyTerm is "fromRule" when a rule's term appears (case-insensitive)
  // inside either the source term or its translation. Substring match —
  // covers "v2" matching "v2 purchases" or the translation preserving the
  // user's preferred form.
  function isFromRule(term, translation) {
    if (ruleTerms.length === 0) return false;
    const a = (term || "").toLowerCase();
    const b = (translation || "").toLowerCase();
    return ruleTerms.some((rt) => a.includes(rt) || b.includes(rt));
  }

  let keyTerms = [];
  if (Array.isArray(parsed.keyTerms)) {
    keyTerms = parsed.keyTerms
      .filter((t) => t && typeof t === "object")
      .slice(0, 5)
      .map((t) => {
        const term = safe(t.term);
        const translation = safe(t.translation);
        return {
          term,
          translation,
          note:     safe(t.note),
          fromRule: isFromRule(term, translation),
        };
      })
      .filter((t) => t.term && t.translation);
  }

  return {
    professionalMeaning: safe(parsed.professionalMeaning),
    contextTranslation:  safe(parsed.contextTranslation),
    genericMistake:      safe(parsed.genericMistake),
    keyTerms,
  };
}

/**
 * Main entry: call Claude and return the normalized result.
 *
 * @param {object} payload - validated request body
 * @returns {Promise<{professionalMeaning, contextTranslation, genericMistake, keyTerms}>}
 */
async function translateWithContext(payload, options = {}) {
  const userMessage = buildUserMessage(payload, options);

  // Backend chooses the model via routing (see src/routing.js). If no model
  // is passed, fall back to config.anthropic.model — same behavior as before.
  const model = options.model || config.anthropic.model;

  const response = await getClient().messages.create({
    model,
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  // The response.content is an array of blocks. We expect a single text block.
  const textBlock = (response.content || []).find((b) => b.type === "text");
  if (!textBlock || !textBlock.text) {
    throw new Error("Empty response from model.");
  }

  let parsed;
  try {
    parsed = extractJson(textBlock.text);
  } catch (err) {
    const e = new Error("Model returned malformed JSON.");
    e.cause = err;
    e.modelOutput = textBlock.text;
    throw e;
  }

  return normalize(parsed, { meaningRules: options.meaningRules });
}

module.exports = { translateWithContext };
