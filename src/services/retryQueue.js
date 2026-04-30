'use strict';

const twilio = require('twilio');
const { log } = require('./logger');

const RETRY_CODES  = new Set(['NADA', 'APAG', 'MENS', 'OCUP', 'NONO', 'CORT', 'VOLTA']);
const MAX_ATTEMPTS = 3;
const RETRY_DELAY  = 2 * 60 * 60 * 1000; // 2 hours
const CHECK_INTERVAL = 5 * 60 * 1000;    // 5 minutes

const queue = []; // { phone, debtorInfo, retryAt, attempts }

function addToRetry(phone, debtorInfo, attempts = 1) {
  if (attempts >= MAX_ATTEMPTS) {
    console.log(`[Retry] ${phone} alcanzó ${MAX_ATTEMPTS} intentos. Fin de reintentos.`);
    return;
  }
  const retryAt = Date.now() + RETRY_DELAY;
  queue.push({ phone, debtorInfo, retryAt, attempts });
  log.retry(phone, attempts + 1, `agendado para ${new Date(retryAt).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`);
}

function isWithinCallHours() {
  const now  = new Date();
  const hour = Number(now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires', hour: 'numeric', hour12: false }));
  return hour >= 10 && hour < 17;
}

async function processRetries() {
  const now  = Date.now();
  const due  = queue.filter(e => e.retryAt <= now);
  if (due.length === 0) return;

  if (!isWithinCallHours()) {
    console.log(`[Retry] ${due.length} pendiente(s) fuera de horario — se procesarán cuando sea horario hábil`);
    return;
  }

  for (const entry of due) {
    // Remove from queue before attempting
    const idx = queue.indexOf(entry);
    if (idx !== -1) queue.splice(idx, 1);

    log.retry(entry.phone, entry.attempts + 1, 'ejecutando');
    try {
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const { createSession } = require('./conversation');

      const call = await client.calls.create({
        to:                   entry.phone,
        from:                 process.env.TWILIO_PHONE_NUMBER,
        url:                  `${process.env.BASE_URL}/voice/incoming`,
        statusCallback:       `${process.env.BASE_URL}/voice/status`,
        statusCallbackMethod: 'POST',
        statusCallbackEvent:  ['initiated', 'ringing', 'answered', 'completed'],
        timeout:              30,
      });

      // Attach debtor info so the call handler has context
      const conversation = require('./conversation');
      conversation.create(call.sid, { ...entry.debtorInfo, _retryAttempt: entry.attempts + 1 });

      console.log(`[Retry] Llamada iniciada. SID: ${call.sid}`);
    } catch (err) {
      console.error(`[Retry] Error al reintentar ${entry.phone}:`, err.message);
    }
  }
}

function startProcessor() {
  console.log('[Retry] Procesador iniciado. Revisando cada 5 minutos.');
  setInterval(processRetries, CHECK_INTERVAL);
}

module.exports = { addToRetry, processRetries, startProcessor, queue, RETRY_CODES };
