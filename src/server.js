/*
 * src/server.js
 * -------------
 * Context.io backend — Express entry point.
 *
 * Responsibilities:
 *   - Wire middleware: helmet, CORS, JSON parsing, rate limiting.
 *   - Expose:
 *       GET  /health           -> liveness probe
 *       POST /translate-context -> the real endpoint the Chrome extension calls
 *   - Centralize error handling so the client always gets a consistent shape:
 *       { error: string }       (on failure)
 *       { professionalMeaning, contextTranslation, genericMistake, keyTerms }  (on success)
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
const { translateWithContext }  = require("./anthropic");
const supabase                  = require("./supabase");
const { attachUser, requireUser } = require("./auth");

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
  methods: ["POST", "GET", "OPTIONS"],
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
app.use("/me",      limiter);
app.use("/profile", limiter);

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
// One-shot bundle used by the popup to render the signed-in panel: identity,
// profile, plan, current usage and the limits that apply to this user.
app.get("/me", requireUser, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const [profile, usedThisMonth] = await Promise.all([
      supabase.getProfile(userId),
      supabase.getMonthlyUsage(userId),
    ]);

    const plan = (profile && profile.plan) || "free";
    const limits = limitsForPlan(plan);

    res.json({
      user: {
        id:    req.user.id,
        email: req.user.email || null,
      },
      profile: profile || null,
      plan,
      usage: {
        used:  usedThisMonth,
        limit: limits.monthlyLimit,
        month: supabase.currentMonthKey(),
      },
      maxChars: limits.maxChars,
    });
  } catch (err) {
    next(err);
  }
});

// ----- GET /profile ----------------------------------------------------------
app.get("/profile", requireUser, async (req, res, next) => {
  try {
    const profile = await supabase.getProfile(req.user.id);
    res.json({ profile: profile || null });
  } catch (err) {
    next(err);
  }
});

// ----- POST /profile ---------------------------------------------------------
// Create or update the user's profile. Body fields are validated against the
// same allowlists used by /translate-context so the saved values always
// match what the translator can accept.
app.post("/profile", requireUser, async (req, res, next) => {
  try {
    const body = req.body || {};
    const patch = {};

    if (typeof body.profession === "string") {
      patch.profession = body.profession.trim().slice(0, 120);
    }
    if (typeof body.sourceLanguage === "string") {
      const v = body.sourceLanguage.trim().toLowerCase();
      if (!ALLOWED_LANGS.has(v)) return res.status(400).json({ error: `sourceLanguage "${v}" not supported` });
      patch.source_language = v;
    }
    if (typeof body.targetLanguage === "string") {
      const v = body.targetLanguage.trim().toLowerCase();
      if (!ALLOWED_LANGS.has(v) || v === "auto") {
        return res.status(400).json({ error: `targetLanguage "${v}" not supported` });
      }
      patch.target_language = v;
    }
    if (typeof body.tone === "string") {
      const v = body.tone.trim().toLowerCase();
      if (!ALLOWED_TONES.has(v)) return res.status(400).json({ error: `tone "${v}" not supported` });
      patch.tone = v;
    }
    if (typeof body.outputFormat === "string") {
      const v = body.outputFormat.trim().toLowerCase();
      if (!ALLOWED_OUTPUT_FORMATS.has(v)) {
        return res.status(400).json({ error: `outputFormat "${v}" not supported` });
      }
      patch.output_format = v;
    }

    const profile = await supabase.upsertProfile(req.user.id, patch);
    res.json({ profile });
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
    let plan = "free";
    if (req.user) {
      const profile = await supabase.getProfile(req.user.id);
      if (profile) {
        plan = profile.plan || "free";
        if (!body.profession     && profile.profession)      body.profession     = profile.profession;
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
      const limits = limitsForPlan(plan);

      // Per-request character cap.
      if (v.value.text.length > limits.maxChars) {
        return res.status(413).json({
          error: "text_too_long",
          maxChars: limits.maxChars,
        });
      }

      // Monthly translation cap.
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

// Plan-based limits. Free uses the env-configured caps; pro is currently
// "no cap" (we use Number.MAX_SAFE_INTEGER so the existing code path stays
// simple — no special-casing needed). Tighten later if pro gets metered.
function limitsForPlan(plan) {
  if (plan === "pro") {
    return {
      monthlyLimit: Number.MAX_SAFE_INTEGER,
      maxChars:     config.limits.maxTextLength,
    };
  }
  return {
    monthlyLimit: config.freeTier.monthlyLimit,
    maxChars:     config.freeTier.maxChars,
  };
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
