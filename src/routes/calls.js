'use strict';

const express = require('express');
const router = express.Router();
const twilio = require('twilio');
const conversation = require('../services/conversation');
const elevenlabs = require('../services/elevenlabs');
const { GREETING_TEMPLATE, UNKNOWN_GREETING } = require('../config/valentina');

const BASE_URL = process.env.BASE_URL;

const { log } = require('../services/logger');

function getTwilioClient() {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

const TWILIO_ERROR_MAP = {
  21211: 'Número inválido',
  21214: 'Número de teléfono no permitido',
  21217: 'Número no puede recibir llamadas',
  21401: 'SIP request inválido',
  21215: 'Llamadas internacionales deshabilitadas',
  13224: 'Número bloqueado por Twilio',
  13225: 'Número en lista negra',
  20003: 'Credenciales Twilio inválidas',
  20404: 'Recurso Twilio no encontrado',
  21604: 'Número origen no verificado',
};

function twilioErrorMessage(err) {
  const code = err.code || err.status;
  if (TWILIO_ERROR_MAP[code]) return `${TWILIO_ERROR_MAP[code]} (${code})`;
  if (code >= 20000 && code < 22000) return `Error Twilio ${code}: ${err.message}`;
  return err.message;
}

function isWithinCallHours() {
  const now = new Date();
  const hour = Number(now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires', hour: 'numeric', hour12: false }));
  return hour >= 10 && hour < 17;
}

/**
 * POST /api/calls/outbound
 * Inicia una llamada saliente a un deudor.
 *
 * Body:
 * {
 *   "to": "+5491112345678",
 *   "debtor": {
 *     "name": "Juan Pérez",
 *     "amount": 150000,
 *     "daysOverdue": 45,
 *     "accountId": "ACC-001"
 *   }
 * }
 */
router.post('/outbound', async (req, res) => {
  const { to, debtor } = req.body;

  if (!isWithinCallHours()) {
    return res.status(403).json({ error: 'Fuera de horario permitido. Llamadas permitidas entre 10:00 y 17:00 hs (Argentina)' });
  }

  if (!to || !debtor) {
    return res.status(400).json({ error: 'Se requieren "to" (número) y "debtor" (datos del deudor)' });
  }

  if (!to.match(/^\+\d{10,15}$/)) {
    return res.status(400).json({ error: 'El número debe estar en formato E.164 (ej: +5491112345678)' });
  }

  if (debtor.name !== undefined) {
    const name = String(debtor.name).trim();
    if (name.length < 2 || name.length > 100) {
      return res.status(400).json({ error: 'El nombre debe tener entre 2 y 100 caracteres' });
    }
  }

  if (debtor.amount !== undefined) {
    const amount = Number(debtor.amount);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'El monto debe ser un número positivo' });
    }
  }

  if (debtor.daysOverdue !== undefined) {
    const days = Number(debtor.daysOverdue);
    if (!Number.isInteger(days) || days < 0) {
      return res.status(400).json({ error: 'daysOverdue debe ser un entero positivo' });
    }
  }

  try {
    const client = getTwilioClient();

    const call = await client.calls.create({
      to,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `${BASE_URL}/voice/incoming`,
      statusCallback: `${BASE_URL}/voice/status`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      timeout: 30,
    });

    // El saludo lo genera el WebSocket handler al conectar
    conversation.create(call.sid, debtor);
    log.call(to, debtor.name, 'outbound-initiated', { callSid: call.sid });

    res.json({
      success: true,
      callSid: call.sid,
      status:  call.status,
      to,
      debtor:  debtor.name,
    });
  } catch (err) {
    const msg = twilioErrorMessage(err);
    log.error('Calls', 'Error iniciando llamada', { to, error: msg, code: err.code });
    const httpStatus = (err.code >= 20000 && err.code < 21000) ? 502 : 400;
    res.status(httpStatus).json({ error: msg, code: err.code || null });
  }
});

/**
 * POST /api/calls/custom
 * Llamada con mensaje y comportamiento completamente personalizados.
 * No usa el prompt de cobranzas — sirve para cualquier tipo de llamada.
 *
 * Body:
 * {
 *   "to": "+5491156061515",
 *   "contactName": "Hernán Slemenson",
 *   "greeting": "Hola Hernán, te llamo de parte de...",
 *   "systemPrompt": "Sos Cole, asistente de Salvador..."
 * }
 */
router.post('/custom', async (req, res) => {
  const { to, contactName, greeting, systemPrompt } = req.body;

  if (!isWithinCallHours()) {
    return res.status(403).json({ error: 'Fuera de horario permitido. Llamadas permitidas entre 10:00 y 17:00 hs (Argentina)' });
  }

  if (!to) {
  return res.status(400).json({ error: 'Se requiere "to"' });
}

const finalGreeting = greeting || `Hola ${contactName || '¿cómo estás?'}`;
const finalSystemPrompt = systemPrompt || 'Sos un asistente amable y conversacional.';

  if (!to.match(/^\+\d{10,15}$/)) {
    return res.status(400).json({ error: 'Número en formato E.164 (ej: +5491112345678)' });
  }

  try {
    const client = getTwilioClient();

    // Pre-generar el saludo con ElevenLabs antes de marcar
    let greetingAudioId = null;
    try {
      greetingAudioId = await elevenlabs.textToSpeech(finalGreeting);
      console.log(`[ElevenLabs] Saludo custom pre-generado: ${greetingAudioId}`);
    } catch (err) {
      console.warn(`[ElevenLabs] Fallback a Twilio TTS: ${err.message}`);
    }

    const call = await client.calls.create({
      to,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `${BASE_URL}/voice/incoming`,
      statusCallback: `${BASE_URL}/voice/status`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      timeout: 30,
    });

    conversation.create(
      call.sid,
      { name: contactName || 'Contacto' },
      greetingAudioId,
      finalSystemPrompt
    );

    console.log(`[Twilio] Llamada custom iniciada a ${to}. SID: ${call.sid}`);

    res.json({ success: true, callSid: call.sid, status: call.status, to, contact: contactName });
  } catch (err) {
    console.error('[Twilio] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/calls/:callSid
 * Consulta el estado de una llamada.
 */
router.get('/:callSid', async (req, res) => {
  const { callSid } = req.params;

  try {
    const client = getTwilioClient();
    const call = await client.calls(callSid).fetch();
    const session = conversation.get(callSid);

    res.json({
      callSid,
      status: call.status,
      duration: call.duration,
      direction: call.direction,
      startTime: call.startTime,
      endTime: call.endTime,
      conversationTurns: session?.history?.length || 0,
      debtor: session?.debtorInfo?.name || null,
    });
  } catch (err) {
    res.status(404).json({ error: 'Llamada no encontrada' });
  }
});

module.exports = router;
