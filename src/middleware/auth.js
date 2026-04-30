'use strict';

const crypto = require('crypto');

const SESSION_COOKIE = 'cole_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

// In-memory session store: token → expiresAt
const sessions = new Map();

function createSession() {
  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, expiresAt);
  // Prune expired sessions lazily
  for (const [t, exp] of sessions) {
    if (exp < Date.now()) sessions.delete(t);
  }
  return token;
}

function isValidSession(token) {
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(token); return false; }
  return true;
}

function destroySession(token) {
  sessions.delete(token);
}

// Express middleware — redirects to /login if no valid session
function requireAuth(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (isValidSession(token)) return next();
  res.redirect('/login');
}

module.exports = { requireAuth, createSession, destroySession, isValidSession, SESSION_COOKIE, SESSION_TTL_MS };
