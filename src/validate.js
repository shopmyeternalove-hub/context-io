/*
 * src/validate.js
 * ---------------
 * Pure validation for the /translate-context request body.
 *
 * Returns either:
 *   { ok: true,  value: <sanitized payload> }
 *   { ok: false, error: "<human-readable message>" }
 *
 * We do not throw — the caller decides whether to send a 400 or something else.
 */

"use strict";

const { config } = require("./config");

// Whitelists. Kept permissive enough to be useful, strict enough to keep
// the prompt clean and predictable.
const ALLOWED_LANGS = new Set([
  "auto", "en", "es", "fr", "de", "it", "pt", "ar", "he",
  "zh", "ja", "ko", "ru", "hi", "tr", "nl", "pl", "sv",
]);

const ALLOWED_TONES = new Set([
  "natural-professional",
  "professional", "formal", "neutral", "conversational",
  "academic", "executive", "plain",
]);

// outputFormat controls writing style/structure (where the translation will
// be pasted), separate from tone (attitude/polish) and profession (meaning).
// "auto" is accepted from clients that can't infer locally, but in practice
// the extension resolves auto -> a concrete format before sending.
const ALLOWED_OUTPUT_FORMATS = new Set([
  "auto",
  "chat",
  "email",
  "client-update",
  "report",
  "technical-note",
  "formal-document",
]);

// Profession is free-form, but we cap length and strip control characters.
const MAX_PROFESSION_LENGTH = 120;

function isString(v) {
  return typeof v === "string";
}

function stripControlChars(s) {
  // Remove ASCII control chars except common whitespace (\t \n \r).
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

function validateTranslateBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }

  const { text, profession, sourceLanguage, targetLanguage, tone, outputFormat } = body;

  // text — required, non-empty, bounded length
  if (!isString(text)) {
    return { ok: false, error: "`text` is required and must be a string." };
  }
  const cleanText = stripControlChars(text).trim();
  if (cleanText.length === 0) {
    return { ok: false, error: "`text` must not be empty." };
  }
  if (cleanText.length > config.limits.maxTextLength) {
    return {
      ok: false,
      error: `\`text\` exceeds max length of ${config.limits.maxTextLength} characters.`,
    };
  }

  // profession — optional, but if present must be a sane string
  let cleanProfession = "";
  if (profession !== undefined && profession !== null) {
    if (!isString(profession)) {
      return { ok: false, error: "`profession` must be a string." };
    }
    cleanProfession = stripControlChars(profession).trim().slice(0, MAX_PROFESSION_LENGTH);
  }

  // sourceLanguage — optional, defaults to "auto"
  const src = isString(sourceLanguage) ? sourceLanguage.trim().toLowerCase() : "auto";
  if (!ALLOWED_LANGS.has(src)) {
    return { ok: false, error: `\`sourceLanguage\` "${src}" is not supported.` };
  }

  // targetLanguage — required
  if (!isString(targetLanguage)) {
    return { ok: false, error: "`targetLanguage` is required and must be a string." };
  }
  const tgt = targetLanguage.trim().toLowerCase();
  if (!ALLOWED_LANGS.has(tgt) || tgt === "auto") {
    return { ok: false, error: `\`targetLanguage\` "${tgt}" is not supported.` };
  }

  // tone — optional, defaults to "natural-professional"
  const t = isString(tone) ? tone.trim().toLowerCase() : "natural-professional";
  if (!ALLOWED_TONES.has(t)) {
    return { ok: false, error: `\`tone\` "${t}" is not supported.` };
  }

  // outputFormat — optional, defaults to "auto"
  const fmt = isString(outputFormat) ? outputFormat.trim().toLowerCase() : "auto";
  if (!ALLOWED_OUTPUT_FORMATS.has(fmt)) {
    return { ok: false, error: `\`outputFormat\` "${fmt}" is not supported.` };
  }

  return {
    ok: true,
    value: {
      text: cleanText,
      profession: cleanProfession,
      sourceLanguage: src,
      targetLanguage: tgt,
      tone: t,
      outputFormat: fmt,
    },
  };
}

module.exports = {
  validateTranslateBody,
  ALLOWED_LANGS,
  ALLOWED_TONES,
  ALLOWED_OUTPUT_FORMATS,
};
