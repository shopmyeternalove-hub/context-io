/*
 * src/server.js
 * -------------
 * Context.io backend — Express entry point.
 *
 * Responsibilities:
 *   - Wire middleware: helmet, CORS, JSON parsing, rate limiting.
 *   - Expose:
 *       GET  /health             -> liveness probe
 *       GET  /me                 -> headline: identity + plan + features + usage + profile
 *       GET  /profile            -> shaped profile read
 *       POST /profile            -> profile write (camelCase + snake_case accepted)
 *       POST /translate-context  -> the real endpoint the Chrome extension calls
 *       GET    /meaning-rules    -> list  (Pro only)
 *       POST   /meaning-rules    -> create (Pro only)
 *       PUT    /meaning-rules/:id -> update (Pro only)
 *       DELETE /meaning-rules/:id -> delete (Pro only)
 *   - Centralize error handling so the client always gets a consistent shape.
 *
 * Security posture:
 *   - The Anthropic API key lives in .env on this server. It is read once at
 *     boot and never returned in any response.
 *   - CORS is allowlist-based (configured via ALLOWED_ORIGINS).
 *   - express-rate-limit caps requests per IP per window.
 *   - Helmet sets sensible default HTTP headers.
 *   - Request body is hard-capped at 64 KB.
 */

"use strict";

const express     = require("express");
const cors        = require("cors");
const helmet      = require("helmet");
const rateLimit   = require("express-rate-limit");

const { config, validate }      = require("./config");
const {
  validateTranslateBody,
  ALLOWED_LANGS,
  ALLOWED_TONES,
  ALLOWED_OUTPUT_FORMATS,
} = require("./validate");
const { translateWithContext }     = require("./anthropic");
const supabase                     = require("./supabase");
const { attachUser, requireUser, requirePro } = require("./auth");
const { getPlan, shapeProfileForPlan } = require("./plans");

// Fail fast if required env (e.g. ANTHROPIC_API_KEY) is missing.
validate();

const app = express();

// ---------- Hardening ----------
app.disable("x-powered-by");
app.set("trust proxy", 1); // safe behind one reverse proxy (Render, Fly, etc.)
app.use(helmet());

// ---------- CORS ----------
// We accept requests from Chrome extension origins (chrome-extension://<id>)
// and any other origins explicitly listed in ALLOWED_ORIGINS.
const allowed = config.cors.allowedOrigins;

const corsOptions = {
  origin(origin, callback) {
    // Same-origin / curl / server-to-server requests have no Origin header.
    if (!origin) return callback(null, true);

    // No allowlist configured -> permissive (development convenience).
    if (allowed.length === 0) return callback(null, true);

    // Wildcard explicitly allowed.
    if (allowed.includes("*")) return callback(null, true);

    if (allowed.includes(origin)) return callback(null, true);
    return callback(new Error(`Origin "${origin}" is not allowed by CORS.`));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86_400,
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// ---------- Body parsing ----------
// 64 KB is plenty for selected text + settings, and stops oversize payloads
// before they touch our handler.
app.use(express.json({ limit: "64kb" }));

// ---------- Rate limiting ----------
const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max:      config.rateLimit.max,
  standardHeaders: true,  // RateLimit-* response headers
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." },
});
// Apply to all authenticated/expensive routes. /health stays unlimited so
// uptime probes don't get throttled.
app.use("/translate-context", limiter);
app.use("/me",             limiter);
app.use("/profile",        limiter);
app.use("/meaning-rules",  limiter);

// ---------- Routes ----------

// Liveness probe — no secrets, no external calls.
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "context.io",
    time: new Date().toISOString(),
    auth: supabase.isEnabled(),
  });
});

// All routes below this point will have req.user attached when a valid
// Bearer token is present. Unauthenticated requests pass through with
// req.user undefined.
app.use(attachUser);

// ----- GET /me ---------------------------------------------------------------
// One-shot bundle used by portal + popup to render the signed-in panel:
// identity, profile (shaped to the user's plan), plan + features, current
// usage and the limits that apply to this user.
//
// Response shape (kept backwards-compatible with the v1 deployed shape, plus
// new fields the portal needs):
//   {
//     user:     { id, email },
//     email:    string,
//     profile:  { ...shaped per plan },      // includes professional_context for Pro
//     plan:     "free" | "pro",
//     features: { basicProfile, detailedProfile, meaningRules, ... },
//     usage:    { used, limit, month },      // limit = null for Pro
//     maxChars: integer,
//   }
app.get("/me", requireUser, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const [rawProfile, usedThisMonth] = await Promise.all([
      supabase.getProfile(userId),
      supabase.getMonthlyUsage(userId),
    ]);

    const planName = (rawProfile && rawProfile.plan) || "free";
    const plan     = getPlan(planName);
    const isPro    = planName === "pro";
    const shaped   = shapeProfileForPlan(rawProfile, planName);

    res.json({
      user: {
        id:    req.user.id,
        email: req.user.email || null,
      },
      email:    req.user.email || null,
      profile:  shaped,
      plan:     planName,
      features: plan.features,
      usage: {
        used:  usedThisMonth,
        // Pro is internally MAX_SAFE_INTEGER (so `used >= limit` stays simple
        // elsewhere) but reported externally as null for cleaner JSON.
        limit: isPro ? null : plan.monthlyLimit,
        month: supabase.currentMonthKey(),
      },
      maxChars: plan.maxChars,
    });
  } catch (err) {
    next(err);
  }
});

// ----- GET /profile ----------------------------------------------------------
// Returns the user's profile, shaped according to their plan.
app.get("/profile", requireUser, async (req, res, next) => {
  try {
    const raw = await supabase.getProfile(req.user.id);
    const planName = (raw && raw.plan) || "free";
    res.json({ profile: shapeProfileForPlan(raw, planName) });
  } catch (err) {
    next(err);
  }
});

// ----- POST /profile ---------------------------------------------------------
// Create or update the user's profile.
//
// Accepts BOTH camelCase (sourceLanguage) and snake_case (source_language)
// so the portal (which sends snake_case) and the extension (which sends
// camelCase) can both write the same fields without translation glue.
//
// New fields:
//   - profile_name (all plans)
//   - professional_context (Pro only — silently ignored for Free so they
//     can never write data they can't read back)
app.post("/profile", requireUser, async (req, res, next) => {
  try {
    const body = req.body || {};
    const patch = {};

    // Helper: prefer snake_case (portal style), fall back to camelCase
    // (extension style). Returns undefined if neither key is a string.
    const pick = (snake, camel) => {
      if (typeof body[snake] === "string") return body[snake];
      if (typeof body[camel] === "string") return body[camel];
      return undefined;
    };

    // --- profile_name (short label) ---
    const profileName = pick("profile_name", "profileName");
    if (typeof profileName === "string") {
      patch.profile_name = profileName.trim().slice(0, 60);
    }

    // --- profession (short, ~120 char, all plans) ---
    if (typeof body.profession === "string") {
      patch.profession = body.profession.trim().slice(0, 120);
    }

    // --- professional_context (long-form, Pro only) ---
    // We read the user's current plan to decide whether to honor this write.
    // Silently dropped for Free — never error — so the same client code path
    // works for both plans.
    const profCtx = pick("professional_context", "professionalContext");
    if (typeof profCtx === "string") {
      const current = await supabase.getProfile(req.user.id);
      const planName = (current && current.plan) || "free";
      if (planName === "pro") {
        patch.professional_context = profCtx.slice(0, 2000);
      }
      // else: silently drop — feature locked
    }

    // --- source_language ---
    const src = pick("source_language", "sourceLanguage");
    if (typeof src === "string") {
      const v = src.trim().toLowerCase();
      if (!ALLOWED_LANGS.has(v)) {
        return res.status(400).json({ error: `sourceLanguage "${v}" not supported` });
      }
      patch.source_language = v;
    }

    // --- target_language ---
    const tgt = pick("target_language", "targetLanguage");
    if (typeof tgt === "string") {
      const v = tgt.trim().toLowerCase();
      if (!ALLOWED_LANGS.has(v) || v === "auto") {
        return res.status(400).json({ error: `targetLanguage "${v}" not supported` });
      }
      patch.target_language = v;
    }

    // --- tone ---
    if (typeof body.tone === "string") {
      const v = body.tone.trim().toLowerCase();
      if (!ALLOWED_TONES.has(v)) {
        return res.status(400).json({ error: `tone "${v}" not supported` });
      }
      patch.tone = v;
    }

    // --- output_format ---
    const fmt = pick("output_format", "outputFormat");
    if (typeof fmt === "string") {
      const v = fmt.trim().toLowerCase();
      if (!ALLOWED_OUTPUT_FORMATS.has(v)) {
        return res.status(400).json({ error: `outputFormat "${v}" not supported` });
      }
      patch.output_format = v;
    }

    const saved = await supabase.upsertProfile(req.user.id, patch);

    // Return the same shape /profile GET returns, so the client can drop the
    // response straight into its form state without a refetch.
    const planName = (saved && saved.plan) || "free";
    res.json({ profile: shapeProfileForPlan(saved, planName) });
  } catch (err) {
    next(err);
  }
});

// ----- POST /translate-context -----------------------------------------------
// Auth is optional. When a user is signed in:
//   1. saved profile fields fill in any missing request fields
//   2. plan-based quotas (monthly limit, max chars) are enforced
//   3. usage is incremented only after a successful Claude response
//
// When no user is present, the route works exactly like before — purely
// stateless. This keeps the unauthenticated dev/test flow alive.
app.post("/translate-context", async (req, res, next) => {
  try {
    const body = { ...(req.body || {}) };

    // 1) If signed in, merge saved profile defaults into missing fields.
    //    We also prepend long-form professional_context (Pro only) to
    //    profession so it reaches the Claude prompt as additional lens.
    let planName = "free";
    if (req.user) {
      const profile = await supabase.getProfile(req.user.id);
      if (profile) {
        planName = profile.plan || "free";

        // For Pro users with long-form context: feed it to the translator
        // by combining short + long into the `profession` field that the
        // prompt builder already understands. (We never mutate the saved
        // row — just the request body for this call.)
        const isPro = planName === "pro";
        const longCtx = isPro ? (profile.professional_context || "").trim() : "";
        const shortPro = (profile.profession || "").trim();
        const merged = longCtx
          ? (shortPro ? `${shortPro}\n\n${longCtx}` : longCtx)
          : shortPro;

        if (!body.profession && merged)            body.profession     = merged;
        if (!body.sourceLanguage && profile.source_language) body.sourceLanguage = profile.source_language;
        if (!body.targetLanguage && profile.target_language) body.targetLanguage = profile.target_language;
        if (!body.tone           && profile.tone)            body.tone           = profile.tone;
        if (!body.outputFormat   && profile.output_format)   body.outputFormat   = profile.output_format;
      }
    }

    // 2) Validate the (possibly profile-merged) body.
    const v = validateTranslateBody(body);
    if (!v.ok) return res.status(400).json({ error: v.error });

    // 3) Enforce plan limits BEFORE calling Claude.
    if (req.user) {
      const limits = getPlan(planName);

      // Per-request character cap.
      if (v.value.text.length > limits.maxChars) {
        return res.status(413).json({
          error: "text_too_long",
          maxChars: limits.maxChars,
        });
      }

      // Monthly translation cap. (Pro's monthlyLimit = MAX_SAFE_INTEGER, so
      // this check is effectively a no-op for them.)
      const used = await supabase.getMonthlyUsage(req.user.id);
      if (used >= limits.monthlyLimit) {
        return res.status(402).json({
          error: "upgrade_required",
          used,
          limit: limits.monthlyLimit,
        });
      }
    }

    // 4) Call Claude.
    const result = await translateWithContext(v.value);

    // 5) On success, bump usage. Failure to bump must NOT fail the request —
    //    the user already got their result; we log and move on.
    if (req.user) {
      supabase.incrementUsage(req.user.id, 1).catch((err) => {
        console.error("[usage] increment failed:", err.message);
      });
    }

    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

// ----- /meaning-rules — Pro feature -----------------------------------------
// All four methods are gated by requirePro("meaning_rules") which returns
// 401 if unauthenticated and 403 { error: "upgrade_required", feature, plan }
// for signed-in Free users. That 403 is what the portal's RequirePro guard
// distinguishes from a real error.

// GET — list all rules for the signed-in user
app.get("/meaning-rules", requirePro("meaning_rules"), async (req, res, next) => {
  try {
    const rules = await supabase.listMeaningRules(req.user.id);
    res.json({ rules });
  } catch (err) {
    next(err);
  }
});

// POST — create a rule
app.post("/meaning-rules", requirePro("meaning_rules"), async (req, res, next) => {
  try {
    const v = validateMeaningRule(req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const rule = await supabase.createMeaningRule(req.user.id, v.value);
    res.status(201).json({ rule });
  } catch (err) {
    // Unique-violation on (user_id, term) — return a friendly 409.
    if (err && /duplicate key|unique/i.test(err.message || "")) {
      return res.status(409).json({ error: "A rule for this term already exists." });
    }
    next(err);
  }
});

// PUT — update a rule
app.put("/meaning-rules/:id", requirePro("meaning_rules"), async (req, res, next) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "missing id" });

    const v = validateMeaningRule(req.body, { partial: true });
    if (!v.ok) return res.status(400).json({ error: v.error });

    const rule = await supabase.updateMeaningRule(req.user.id, id, v.value);
    if (!rule) return res.status(404).json({ error: "rule not found" });
    res.json({ rule });
  } catch (err) {
    next(err);
  }
});

// DELETE — delete a rule
app.delete("/meaning-rules/:id", requirePro("meaning_rules"), async (req, res, next) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "missing id" });
    const removed = await supabase.deleteMeaningRule(req.user.id, id);
    if (!removed) return res.status(404).json({ error: "rule not found" });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Validation for the meaning-rule body. Keeps the route handlers focused.
// `partial` mode allows missing `term` (used by PUT).
function validateMeaningRule(body, { partial = false } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }
  const out = {};
  const str = (v) => (typeof v === "string" ? v : "");

  if (typeof body.term === "string") {
    const t = body.term.trim().slice(0, 80);
    if (!t && !partial) return { ok: false, error: "`term` is required." };
    if (t) out.term = t;
  } else if (!partial) {
    return { ok: false, error: "`term` is required and must be a string." };
  }

  for (const f of ["user_meaning", "preferred_translation", "avoid_translation", "example_sentence", "notes"]) {
    if (body[f] !== undefined) {
      out[f] = str(body[f]).slice(0, 500);
    }
  }
  return { ok: true, value: out };
}

// ---------- 404 ----------
app.use((req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
});

// ---------- Error handler ----------
// One central place to translate exceptions into safe JSON responses.
// We deliberately do not leak stack traces or upstream provider details.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  // CORS rejections from the origin function above arrive here.
  if (err && /CORS/i.test(err.message || "")) {
    return res.status(403).json({ error: err.message });
  }

  // express.json size / parse errors.
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body too large." });
  }
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON body." });
  }

  // Anthropic SDK errors have a numeric `status` field.
  if (err && typeof err.status === "number") {
    const upstream = err.status;
    // Map a few cases to friendlier client messages; collapse the rest.
    if (upstream === 401 || upstream === 403) {
      console.error("[anthropic] auth error:", err.message);
      return res.status(500).json({ error: "Translation service is misconfigured." });
    }
    if (upstream === 429) {
      return res.status(429).json({ error: "Upstream rate limit reached. Try again shortly." });
    }
    if (upstream >= 500) {
      console.error("[anthropic] upstream error:", err.message);
      return res.status(502).json({ error: "Translation service is temporarily unavailable." });
    }
    // 4xx from upstream we didn't validate against (rare).
    console.error("[anthropic] client error:", err.message);
    return res.status(400).json({ error: "Translation request rejected by provider." });
  }

  // Anything else.
  console.error("[server] unhandled error:", err);
  res.status(500).json({ error: "Internal server error." });
});

// ---------- Start ----------
const server = app.listen(config.port, () => {
  console.log(
    `Context.io backend listening on http://localhost:${config.port} ` +
    `(env: ${config.nodeEnv}, model: ${config.anthropic.model})`
  );
  if (allowed.length === 0) {
    console.log("⚠  No ALLOWED_ORIGINS set — CORS is open. Set this before deploying.");
  } else {
    console.log("CORS allowlist:", allowed.join(", "));
  }
});

// Graceful shutdown — helps when running under PM2, Docker, etc.
function shutdown(signal) {
  console.log(`\n${signal} received — shutting down.`);
  server.close(() => process.exit(0));
  // Force-exit if close hangs.
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
