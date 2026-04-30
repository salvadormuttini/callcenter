'use strict';

const { v4: uuidv4 }  = require('uuid');
const twilio           = require('twilio');
const conversation     = require('./conversation');
const { log }          = require('./logger');
const {
  saveQueueItem,
  updateQueueRow,
  loadPendingQueue,
  cancelAllPendingQueueItems,
} = require('./googleSheets');

const CALL_GAP_MS = 8000;

// Item shape: { id, phone, debtorInfo, status, callSid, error, addedAt, _sheetsRow }
const queue = [];

let processing = false;
let stopped    = false;

// ── Sheets helpers (fire-and-forget to never block the queue) ─────────────────

function persistSave(item) {
  saveQueueItem(item)
    .then(row => { if (row) item._sheetsRow = row; })
    .catch(e => log.warn('Queue', 'No se pudo guardar item en Sheets', { error: e.message }));
}

function persistUpdate(item) {
  if (!item._sheetsRow) return;
  updateQueueRow(item._sheetsRow, item.status, item.callSid, item.error)
    .catch(e => log.warn('Queue', 'No se pudo actualizar item en Sheets', { error: e.message }));
}

// ── Public API ────────────────────────────────────────────────────────────────

function addToQueue(debtorInfo, phone, id = uuidv4()) {
  const item = { id, phone, debtorInfo, status: 'pending', callSid: null, error: null, addedAt: Date.now(), _sheetsRow: null };
  queue.push(item);
  persistSave(item);
  log.info('Queue', `Encolado ${debtorInfo.name || phone}`, { id, queueLen: queue.length });
  return id;
}

function addBatch(debtors) {
  stopped = false;
  return debtors.map(d => addToQueue(d, d.phone, d.id || uuidv4()));
}

function clearPending() {
  const cancelled = queue.filter(i => i.status === 'pending');
  cancelled.forEach(i => {
    i.status = 'cancelled';
    persistUpdate(i);
  });
  stopped = true;
  log.info('Queue', `Cola detenida — ${cancelled.length} pendientes cancelados`);
  return cancelled.length;
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

// Async reset: clears memory AND marks pending Sheets rows as cancelled.
async function resetQueueAndSheets() {
  resetQueue();
  try {
    await cancelAllPendingQueueItems();
  } catch (e) {
    log.warn('Queue', 'No se pudo cancelar items previos en Sheets', { error: e.message });
  }
}

// Load pending items from Sheets and resume processing (called on server startup).
async function resumeFromSheets() {
  let pending = [];
  try {
    pending = await loadPendingQueue();
  } catch (e) {
    log.warn('Queue', 'No se pudo cargar cola desde Sheets', { error: e.message });
    return;
  }

  if (pending.length === 0) return;

  log.info('Queue', `Retomando ${pending.length} llamadas pendientes del reinicio anterior`);
  pending.forEach(item => queue.push(item));
  startProcessing();
}

// ── Internal processor ────────────────────────────────────────────────────────

async function processQueue() {
  if (processing) return;
  processing = true;
  log.info('Queue', 'Procesador iniciado');

  while (true) {
    if (stopped) break;

    const item = queue.find(i => i.status === 'pending');
    if (!item) break;

    item.status = 'calling';
    persistUpdate(item);
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
      persistUpdate(item);
      conversation.create(call.sid, item.debtorInfo);
      log.info('Queue', `Llamada iniciada SID=${call.sid}`, { id: item.id });
    } catch (err) {
      item.status = 'error';
      item.error  = err.message;
      persistUpdate(item);
      log.error('Queue', `Error llamando ${item.phone}`, { id: item.id, error: err.message });
    }

    if (!stopped && queue.some(i => i.status === 'pending')) {
      await delay(CALL_GAP_MS);
    }
  }

  processing = false;
  log.info('Queue', 'Procesador finalizado', getQueueStatus());
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function startProcessing() {
  processQueue().catch(err => log.error('Queue', 'Error inesperado en procesador', { error: err.message }));
}

module.exports = { addToQueue, addBatch, clearPending, getQueueStatus, resetQueue, resetQueueAndSheets, resumeFromSheets, startProcessing };
