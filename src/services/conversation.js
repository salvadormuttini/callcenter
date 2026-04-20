'use strict';

// Estado en memoria por CallSid.
// En producción, reemplazar con Redis para soporte multi-instancia.
const sessions = new Map();

const TTL_MS = 60 * 60 * 1000; // 1 hora

function create(callSid, debtorInfo, greetingAudioId = null) {
  sessions.set(callSid, {
    callSid,
    debtorInfo,           // { name, amount, daysOverdue, accountId }
    greetingAudioId,      // audio pre-generado antes de marcar (null = generar al contestar)
    history: [],          // [{ role: 'user'|'assistant', content: string }]
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  });
}

function get(callSid) {
  return sessions.get(callSid) || null;
}

function addTurn(callSid, role, content) {
  const session = sessions.get(callSid);
  if (!session) return;
  session.history.push({ role, content });
  session.lastActivityAt = Date.now();
}

function destroy(callSid) {
  sessions.delete(callSid);
}

// Limpieza automática de sesiones viejas cada 30 minutos
setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [sid, session] of sessions) {
    if (session.lastActivityAt < cutoff) sessions.delete(sid);
  }
}, 30 * 60 * 1000);

module.exports = { create, get, addTurn, destroy };
