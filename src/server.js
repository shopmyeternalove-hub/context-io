/*
 * src/server.js
 * -------------
 * Context.io backend — Express entry point.
 *
 * v3 changes vs v2:
 *   - New /profiles CRUD endpoints (Pro: unlimited; Free: capped at 1).
 *   - /me, /profile, /translate-context use the new joined view from
 *     supabase.getProfile() — no shape change on the wire.
 *
 * Routes:
 *   GET    /health                  liveness probe
 *   GET    /me                      identity + plan + features + usage + active profile
 *   GET    /profile                 the active profile (shaped per plan)
 *   POST   /profile                 update active profile / global settings
 *   POST   /translate-context       the real endpoint the Chrome extension calls
 *   GET    /profiles                list all profession profiles (Pro)
 *   POST   /profiles                create a new profession profile (Pro)
 *   PUT    /profiles/:id            rename / edit a profession profile (Pro)
 *   DELETE /profiles/:id            delete a profession profile (Pro, not active)
 *   POST   /profiles/:id/activate   switch active profession profile (Pro)
 *   GET    /meaning-rules           list (Pro)
 *   POST   /meaning-rules           create (Pro)
 *   PUT    /meaning-rules/:id       update (Pro)
 *   DELETE /meaning-rules/:id       delete (Pro)
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

validate();

const app = express();

// ---------- Hardening ----------
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet());

// ---------- CORS ----------
const allowed = config.cors.allowedOrigins;
const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowed.length === 0) return callback(null, true);
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
app.use(express.json({ limit: "64kb" }));

// ---------- Rate limiting ----------
const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max:      config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." },
});
app.use("/translate-context", limiter);
app.use("/me",              limiter);
app.use("/profile",         limiter);
app.use("/profiles",        limiter);
app.use("/meaning-rules",   limiter);

// ---------- /health ----------
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "context.io",
    time: new Date().toISOString(),
    auth: supabase.isEnabled(),
  });
});

app.use(attachUser);

// ----- GET /me ---------------------------------------------------------------
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
      user:     { id: req.user.id, email: req.user.email || null },
      email:    req.user.email || null,
      profile:  shaped,
      plan:     planName,
      features: plan.features,
      usage: {
        used:  usedThisMonth,
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
// Accepts both snake_case (portal) and camelCase (extension) for writes.
// Splits the patch between user_profiles (global settings) and the active
// profession_profile row — handled internally by supabase.upsertProfile().
app.post("/profile", requireUser, async (req, res, next) => {
  try {
    const body = req.body || {};
    const patch = {};

    const pick = (snake, camel) => {
      if (typeof body[snake] === "string") return body[snake];
      if (typeof body[camel] === "string") return body[camel];
      return undefined;
    };

    // ---- Profession-profile fields (apply to the active row) ----
    const profileName = pick("profile_name", "profileName");
    if (typeof profileName === "string") {
      const v = profileName.trim().slice(0, 60);
      // For an explicit empty after trim, we just don't include it — name
      // changes can't blank an existing name (DB has CHECK > 0).
      if (v.length > 0) patch.profile_name = v;
    }

    if (typeof body.profession === "string") {
      patch.profession = body.profession.trim().slice(0, 120);
    }

    const profCtx = pick("professional_context", "professionalContext");
    if (typeof profCtx === "string") {
      // Plan check: free users silently get this dropped.
      const current  = await supabase.getProfile(req.user.id);
      const planName = (current && current.plan) || "free";
      if (planName === "pro") {
        patch.professional_context = profCtx.slice(0, 2000);
      }
    }

    // ---- Global settings ----
    const src = pick("source_language", "sourceLanguage");
    if (typeof src === "string") {
      const v = src.trim().toLowerCase();
      if (!ALLOWED_LANGS.has(v)) {
        return res.status(400).json({ error: `sourceLanguage "${v}" not supported` });
      }
      patch.source_language = v;
    }

    const tgt = pick("target_language", "targetLanguage");
    if (typeof tgt === "string") {
      const v = tgt.trim().toLowerCase();
      if (!ALLOWED_LANGS.has(v) || v === "auto") {
        return res.status(400).json({ error: `targetLanguage "${v}" not supported` });
      }
      patch.target_language = v;
    }

    if (typeof body.tone === "string") {
      const v = body.tone.trim().toLowerCase();
      if (!ALLOWED_TONES.has(v)) {
        return res.status(400).json({ error: `tone "${v}" not supported` });
      }
      patch.tone = v;
    }

    const fmt = pick("output_format", "outputFormat");
    if (typeof fmt === "string") {
      const v = fmt.trim().toLowerCase();
      if (!ALLOWED_OUTPUT_FORMATS.has(v)) {
        return res.status(400).json({ error: `outputFormat "${v}" not supported` });
      }
      patch.output_format = v;
    }

    const saved    = await supabase.upsertProfile(req.user.id, patch);
    const planName = (saved && saved.plan) || "free";
    res.json({ profile: shapeProfileForPlan(saved, planName) });
  } catch (err) {
    next(err);
  }
});

// ----- POST /translate-context -----------------------------------------------
// Unchanged in shape; consumes the joined profile view via supabase.getProfile.
app.post("/translate-context", async (req, res, next) => {
  try {
    const body = { ...(req.body || {}) };

    let planName = "free";
    if (req.user) {
      const profile = await supabase.getProfile(req.user.id);
      if (profile) {
        planName = profile.plan || "free";

        const isPro    = planName === "pro";
        const longCtx  = isPro ? (profile.professional_context || "").trim() : "";
        const shortPro = (profile.profession || "").trim();
        const merged   = longCtx
          ? (shortPro ? `${shortPro}\n\n${longCtx}` : longCtx)
          : shortPro;

        if (!body.profession     && merged)                  body.profession     = merged;
        if (!body.sourceLanguage && profile.source_language) body.sourceLanguage = profile.source_language;
        if (!body.targetLanguage && profile.target_language) body.targetLanguage = profile.target_language;
        if (!body.tone           && profile.tone)            body.tone           = profile.tone;
        if (!body.outputFormat   && profile.output_format)   body.outputFormat   = profile.output_format;
      }
    }

    const v = validateTranslateBody(body);
    if (!v.ok) return res.status(400).json({ error: v.error });

    if (req.user) {
      const limits = getPlan(planName);
      if (v.value.text.length > limits.maxChars) {
        return res.status(413).json({ error: "text_too_long", maxChars: limits.maxChars });
      }
      const used = await supabase.getMonthlyUsage(req.user.id);
      if (used >= limits.monthlyLimit) {
        return res.status(402).json({ error: "upgrade_required", used, limit: limits.monthlyLimit });
      }
    }

    // Load the user's meaning rules (Pro-only feature). These are injected
    // into the translator's prompt as a domain glossary so terms like "v2"
    // or "v8" carry their professional meaning into the output.
    // Failure here must NOT block translation — fall back to no rules and
    // log the error.
    let meaningRules = [];
    if (req.user && planName === "pro") {
      try {
        meaningRules = await supabase.listMeaningRules(req.user.id);
      } catch (err) {
        console.error("[meaning-rules] read failed (continuing without rules):", err.message);
      }
    }

    const result = await translateWithContext(v.value, { meaningRules });

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

// ===== /profiles — multi-profile (Pro) ======================================

// GET — list
app.get("/profiles", requirePro("multiple_profiles"), async (req, res, next) => {
  try {
    const [profiles, current] = await Promise.all([
      supabase.listProfessionProfiles(req.user.id),
      supabase.getProfile(req.user.id),
    ]);
    res.json({
      profiles,
      active_profile_id: current ? current.active_profile_id : null,
    });
  } catch (err) {
    next(err);
  }
});

// POST — create
app.post("/profiles", requirePro("multiple_profiles"), async (req, res, next) => {
  try {
    const v = validateProfessionProfileBody(req.body, { requireName: true });
    if (!v.ok) return res.status(400).json({ error: v.error });

    // Cap enforcement. For Pro this is Infinity, but the check is kept so
    // changing the cap in plans.js takes effect without touching the route.
    const plan = getPlan("pro");
    if (Number.isFinite(plan.maxProfiles)) {
      const existing = await supabase.countProfessionProfiles(req.user.id);
      if (existing >= plan.maxProfiles) {
        return res.status(403).json({
          error: "profile_limit_reached",
          limit: plan.maxProfiles,
        });
      }
    }

    const profile = await supabase.createProfessionProfile(req.user.id, v.value);
    res.status(201).json({ profile });
  } catch (err) {
    next(err);
  }
});

// PUT — update
app.put("/profiles/:id", requirePro("multiple_profiles"), async (req, res, next) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "missing id" });

    const v = validateProfessionProfileBody(req.body, { requireName: false });
    if (!v.ok) return res.status(400).json({ error: v.error });

    const profile = await supabase.updateProfessionProfile(req.user.id, id, v.value);
    if (!profile) return res.status(404).json({ error: "profile not found" });
    res.json({ profile });
  } catch (err) {
    next(err);
  }
});

// DELETE — delete (must not be active)
app.delete("/profiles/:id", requirePro("multiple_profiles"), async (req, res, next) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "missing id" });

    // Cannot delete the active profile. Caller must activate another first.
    const current = await supabase.getProfile(req.user.id);
    if (current && current.active_profile_id === id) {
      return res.status(409).json({
        error: "cannot_delete_active_profile",
        active_profile_id: id,
      });
    }

    const removed = await supabase.deleteProfessionProfile(req.user.id, id);
    if (!removed) return res.status(404).json({ error: "profile not found" });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST — activate
app.post("/profiles/:id/activate", requirePro("multiple_profiles"), async (req, res, next) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "missing id" });

    const ok = await supabase.activateProfessionProfile(req.user.id, id);
    if (!ok) return res.status(404).json({ error: "profile not found" });

    const raw      = await supabase.getProfile(req.user.id);
    const planName = (raw && raw.plan) || "free";
    res.json({ profile: shapeProfileForPlan(raw, planName) });
  } catch (err) {
    next(err);
  }
});

// Validation for profession profile body.
function validateProfessionProfileBody(body, { requireName }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }
  const out = {};
  const trimStr = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : null);

  if (typeof body.profile_name === "string" || typeof body.profileName === "string") {
    const raw = (typeof body.profile_name === "string") ? body.profile_name : body.profileName;
    const v = raw.trim().slice(0, 60);
    if (!v) {
      if (requireName) {
        return { ok: false, error: "`profile_name` must be a non-empty string." };
      }
      // partial update with empty string → ignore, can't blank a required name
    } else {
      out.profile_name = v;
    }
  } else if (requireName) {
    return { ok: false, error: "`profile_name` is required." };
  }

  if (typeof body.profession === "string") {
    out.profession = body.profession.trim().slice(0, 120);
  }

  const ctx = (typeof body.professional_context === "string")
    ? body.professional_context
    : (typeof body.professionalContext === "string" ? body.professionalContext : null);
  if (typeof ctx === "string") {
    out.professional_context = ctx.slice(0, 2000);
  }

  return { ok: true, value: out };
}

// ===== /meaning-rules — Pro =================================================

app.get("/meaning-rules", requirePro("meaning_rules"), async (req, res, next) => {
  try {
    const rules = await supabase.listMeaningRules(req.user.id);
    res.json({ rules });
  } catch (err) { next(err); }
});

app.post("/meaning-rules", requirePro("meaning_rules"), async (req, res, next) => {
  try {
    const v = validateMeaningRule(req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const rule = await supabase.createMeaningRule(req.user.id, v.value);
    res.status(201).json({ rule });
  } catch (err) {
    if (err && /duplicate key|unique/i.test(err.message || "")) {
      return res.status(409).json({ error: "A rule for this term already exists." });
    }
    next(err);
  }
});

app.put("/meaning-rules/:id", requirePro("meaning_rules"), async (req, res, next) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "missing id" });
    const v = validateMeaningRule(req.body, { partial: true });
    if (!v.ok) return res.status(400).json({ error: v.error });
    const rule = await supabase.updateMeaningRule(req.user.id, id, v.value);
    if (!rule) return res.status(404).json({ error: "rule not found" });
    res.json({ rule });
  } catch (err) { next(err); }
});

app.delete("/meaning-rules/:id", requirePro("meaning_rules"), async (req, res, next) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "missing id" });
    const removed = await supabase.deleteMeaningRule(req.user.id, id);
    if (!removed) return res.status(404).json({ error: "rule not found" });
    res.status(204).end();
  } catch (err) { next(err); }
});

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
    if (body[f] !== undefined) out[f] = str(body[f]).slice(0, 500);
  }
  return { ok: true, value: out };
}

// ---------- 404 ----------
app.use((req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
});

// ---------- Error handler ----------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err && /CORS/i.test(err.message || "")) {
    return res.status(403).json({ error: err.message });
  }
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body too large." });
  }
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON body." });
  }
  if (err && typeof err.status === "number") {
    const upstream = err.status;
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
    console.error("[anthropic] client error:", err.message);
    return res.status(400).json({ error: "Translation request rejected by provider." });
  }
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

function shutdown(signal) {
  console.log(`\n${signal} received — shutting down.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
