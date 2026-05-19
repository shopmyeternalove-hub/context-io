/*
 * src/config.js
 * -------------
 * Loads environment variables once, validates them, and exports a typed
 * config object. Keeping this in one place means the rest of the app never
 * touches process.env directly.
 */

"use strict";

require("dotenv").config();

// Parse a comma-separated origin list into a clean array.
function parseOrigins(raw) {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Parse an integer env var with a default fallback.
function intEnv(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) {
    throw new Error(`Invalid integer for env ${name}: "${v}"`);
  }
  return n;
}

const config = {
  nodeEnv:     process.env.NODE_ENV || "development",
  port:        intEnv("PORT", 8787),

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model:  process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
  },

  supabase: {
    // Both are optional at config-load time so the backend can still boot
    // without auth in pure-dev mode. validate() below warns if they're
    // missing but doesn't throw.
    url:            process.env.SUPABASE_URL || "",
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  },

  freeTier: {
    monthlyLimit: intEnv("FREE_MONTHLY_LIMIT", 50),
    maxChars:     intEnv("FREE_MAX_CHARS", 700),
  },

  cors: {
    // Empty array => allow any origin (used only if ALLOWED_ORIGINS is unset).
    // "*" entry => explicit any-origin.
    allowedOrigins: parseOrigins(process.env.ALLOWED_ORIGINS),
  },

  rateLimit: {
    windowMs: intEnv("RATE_LIMIT_WINDOW_MS", 60_000),
    max:      intEnv("RATE_LIMIT_MAX", 30),
  },

  limits: {
    maxTextLength: intEnv("MAX_TEXT_LENGTH", 4000),
  },
};

// Fail fast on missing required config.
function validate() {
  if (!config.anthropic.apiKey) {
    throw new Error(
      "Missing ANTHROPIC_API_KEY. Copy .env.example to .env and set it."
    );
  }
  // Supabase is optional — without it, /me, /profile, and authenticated
  // /translate-context paths simply don't work, but unauthenticated
  // /translate-context still does. Warn rather than throw.
  if (!config.supabase.url || !config.supabase.serviceRoleKey) {
    console.warn(
      "⚠  Supabase env not set (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY). " +
      "Auth, profiles, and usage tracking will be disabled."
    );
  }
}

module.exports = { config, validate };
