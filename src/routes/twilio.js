'use strict';

const express  = require('express');
const router   = express.Router();
const twilio   = require('twilio');
const conversation = require('../services/conversation');
const { generateAndSendReport } = require('../services/callReport');

const BASE_URL = process.env.BASE_URL;
const WS_URL   = BASE_URL.replace(/^https?:\/\//, 'wss://') + '/voice/stream';

// ─── /incoming — devuelve TwiML para conectar el Media Stream ─────────────────

router.post('/incoming', (req, res) => {
  const callSid = req.body.CallSid;
  console.log(`[Twilio] Llamada entrante: ${callSid} → conectando Media Stream`);

  const twiml = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  connect.stream({ url: WS_URL });

  res.type('text/xml').send(twiml.toString());
});

// ─── /status — webhook de estado de Twilio (sin cambios) ─────────────────────

router.post('/status', (req, res) => {
  const { CallSid, CallStatus, CallDuration } = req.body;
  console.log(`[Twilio] ${CallSid}: ${CallStatus}`);

  if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(CallStatus)) {
    const s = conversation.get(CallSid);
    if (s) {
      console.log(`[${CallSid}] ${s.history.length} turnos — generando reporte`);
      generateAndSendReport(s, CallSid, CallStatus, CallDuration)
        .then(() => { console.log(`[${CallSid}] REPORTE OK`); conversation.destroy(CallSid); })
        .catch(err => { console.error(`[${CallSid}] REPORTE ERROR:`, err.message); conversation.destroy(CallSid); });
    }
  }

  res.sendStatus(200);
});

module.exports = router;
