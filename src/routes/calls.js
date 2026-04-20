'use strict';

const express = require('express');
const router = express.Router();
const twilio = require('twilio');
const conversation = require('../services/conversation');
const elevenlabs = require('../services/elevenlabs');
const { GREETING_TEMPLATE, UNKNOWN_GREETING } = require('../config/valentina');

const BASE_URL = process.env.BASE_URL;

function getTwilioClient() {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
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

  if (!to || !debtor) {
    return res.status(400).json({ error: 'Se requieren "to" (número) y "debtor" (datos del deudor)' });
  }

  if (!to.match(/^\+\d{10,15}$/)) {
    return res.status(400).json({ error: 'El número debe estar en formato E.164 (ej: +5491112345678)' });
  }

  try {
    const client = getTwilioClient();

    // Pre-generar el saludo ANTES de marcar → 0 latencia al contestar
    const greeting = GREETING_TEMPLATE(debtor.name);
    let greetingAudioId = null;
    try {
      greetingAudioId = await elevenlabs.textToSpeech(greeting);
      console.log(`[ElevenLabs] Saludo pre-generado: ${greetingAudioId}`);
    } catch (err) {
      console.warn(`[ElevenLabs] No se pudo pre-generar saludo (fallback a Twilio TTS): ${err.message}`);
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

    // Registrar sesión con saludo ya listo
    conversation.create(call.sid, debtor, greetingAudioId);
    console.log(`[Twilio] Llamada iniciada a ${to}. SID: ${call.sid}`);

    res.json({
      success: true,
      callSid: call.sid,
      status: call.status,
      to,
      debtor: debtor.name,
    });
  } catch (err) {
    console.error('[Twilio] Error iniciando llamada:', err.message);
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
