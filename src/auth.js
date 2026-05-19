/*
 * src/auth.js
 * -----------
 * Middleware that reads `Authorization: Bearer <jwt>` and, if the token is
 * valid, attaches the Supabase user to req.user.
 *
 * Modes:
 *   attachUser     — soft auth. If a token is present and valid, attach the
 *                    user. If absent or invalid, continue anonymously. Used
 *                    by /translate-context so dev/no-login flows keep working.
 *
 *   requireUser    — hard auth. Returns 401 unless req.user is set. Used by
 *                    /me, /profile, and anything that needs identity.
 *
 * The middleware never throws on a bad token; that just leaves req.user
 * undefined. The route guards decide whether that's acceptable.
 */

"use strict";

const supabase = require("./supabase");

// Extract the raw token from "Authorization: Bearer <jwt>". Returns null if
// the header is missing or malformed.
function readBearer(req) {
  const h = req.headers["authorization"] || req.headers["Authorization"];
  if (!h || typeof h !== "string") return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

async function attachUser(req, _res, next) {
  try {
    const token = readBearer(req);
    if (!token) return next();
    const user = await supabase.verifyAccessToken(token);
    if (user) req.user = user;
  } catch (err) {
    // Don't fail the request on auth errors — just continue anonymously.
    console.warn("[auth] token verification error:", err.message);
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "authentication required" });
  }
  next();
}

module.exports = { attachUser, requireUser, readBearer };
