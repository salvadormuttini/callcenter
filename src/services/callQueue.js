'use strict';

const { v4: uuidv4 } = require('uuid');
const twilio        = require('twilio');
const conversation  = require('./conversation');
const { log }       = require('./logger');

const CALL_GAP_MS = 8000; // delay between calls

// Item shape: { id, phone, debtorInfo, status, callSid, error, addedAt }
const queue = [];

let processing = false;
let stopped    = false;

// ── Public API ──────────────────────────────────────────────────────────────

function addToQueue(debtorInfo, phone, id = uuidv4()) {
  queue.push({ id, phone, debtorInfo, status: 'pending', callSid: null, error: null, addedAt: Date.now() });
  log.info('Queue', `Encolado ${debtorInfo.name || phone}`, { id, queueLen: queue.length });
  return id;
}

function addBatch(debtors) {
  stopped = false;
  return debtors.map(d => addToQueue(d, d.phone, d.id || uuidv4()));
}

function clearPending() {
  const removed = queue.filter(i => i.status === 'pending').length;
  queue.forEach(i => { if (i.status === 'pending') i.status = 'cancelled'; });
  stopped = true;
  log.info('Queue', `Cola detenida — ${removed} pendientes cancelados`);
  return removed;
}

function getQueueStatus() {
  const counts = { pending: 0, calling: 0, done: 0, error: 0, cancelled: 0, total: queue.length };
  queue.forEach(i => { if (counts[i.status] !== undefined) counts[i.status]++; });
  return { ...counts, items: queue.map(({ id, status, callSid, error }) => ({ id, status, callSid, error })) };
}

function resetQueue() {
  queue.length = 0;
  processing   = false;
  stopped      = false;
}

// ── Internal processor ──────────────────────────────────────────────────────

async function processQueue() {
  if (processing) return;
  processing = true;
  log.info('Queue', 'Procesador iniciado');

  while (true) {
    if (stopped) break;

    const item = queue.find(i => i.status === 'pending');
    if (!item) break;

    item.status = 'calling';
    log.call(item.phone, item.debtorInfo?.name, 'queue-call', { id: item.id });

    try {
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const call   = await client.calls.create({
        to:                   item.phone,
        from:                 process.env.TWILIO_PHONE_NUMBER,
        url:                  `${process.env.BASE_URL}/voice/incoming`,
        statusCallback:       `${process.env.BASE_URL}/voice/status`,
        statusCallbackMethod: 'POST',
        statusCallbackEvent:  ['initiated', 'ringing', 'answered', 'completed'],
        timeout:              30,
      });

      item.callSid = call.sid;
      item.status  = 'done';
      conversation.create(call.sid, item.debtorInfo);
      log.info('Queue', `Llamada iniciada SID=${call.sid}`, { id: item.id });
    } catch (err) {
      item.status = 'error';
      item.error  = err.message;
      log.error('Queue', `Error llamando ${item.phone}`, { id: item.id, error: err.message });
    }

    // 8-second gap before next call
    if (!stopped && queue.some(i => i.status === 'pending')) {
      await delay(CALL_GAP_MS);
    }
  }

  processing = false;
  log.info('Queue', 'Procesador finalizado', getQueueStatus());
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Start ──────────────────────────────────────────────────────────────────

function startProcessing() {
  // Fire-and-forget; errors are caught inside processQueue
  processQueue().catch(err => log.error('Queue', 'Error inesperado en procesador', { error: err.message }));
}

module.exports = { addToQueue, addBatch, clearPending, getQueueStatus, resetQueue, startProcessing };
