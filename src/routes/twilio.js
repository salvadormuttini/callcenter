'use strict';

const express = require('express');
const router = express.Router();
const twilio = require('twilio');
const { PassThrough } = require('stream');
const { v4: uuidv4 } = require('uuid');
const conversation = require('../services/conversation');
const claude = require('../services/claude');
const elevenlabs = require('../services/elevenlabs');
const { generateAndSendReport } = require('../services/callReport');
const { GREETING_TEMPLATE, UNKNOWN_GREETING } = require('../config/valentina');

const BASE_URL = process.env.BASE_URL;
const GATHER_TIMEOUT = 7;

// Streams activos: token → PassThrough registrado antes de que lleguen datos.
// Twilio empieza a descargar inmediatamente — no necesita polling.
const pendingStreams = new Map();

setInterval(() => {
  const cutoff = Date.now() - 3 * 60 * 1000;
  for (const [t, e] of pendingStreams) {
    if (e.createdAt < cutoff) { e.stream.destroy(); pendingStreams.delete(t); }
  }
}, 60 * 1000);

// ─── TwiML ───────────────────────────────────────────────────────────────────

function buildGatherTwiml(audioUrl, gatherAction) {
  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    input: 'speech',
    action: gatherAction,
    method: 'POST',
    language: 'es-AR',
    speechTimeout: 'auto',
    timeout: GATHER_TIMEOUT,
  });

  gather.play(audioUrl);

  return twiml.toString();
}

function buildFallbackTwiml(text, gatherAction) {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say({ language: 'es-AR', voice: 'Polly.Lupe' }, text);

  twiml.gather({
    input: 'speech',
    action: gatherAction,
    method: 'POST',
    language: 'es-AR',
    speechTimeout: 'auto',
    timeout: GATHER_TIMEOUT
  });

  return twiml.toString();
}

// ─── Core: frase por frase → PassThrough ─────────────────────────────────────

/**
 * Crea un PassThrough y lo registra inmediatamente.
 * En background: Claude streaming frase por frase → ElevenLabs → PassThrough.
 * Twilio puede empezar a descargar /audio/live/:token sin esperar nada.
 */
function createStreamingToken(callSid, session) {
  const token = uuidv4();
  const passThrough = new PassThrough();
  pendingStreams.set(token, { stream: passThrough, createdAt: Date.now() });

  const t0 = Date.now();
  let firstSentence = true;

  ;(async () => {
    try {
      const fullReply = await claude.streamBySentence(
        session.history,
        session.debtorInfo,
        async (sentence) => {
          if (firstSentence) {
            console.log(`[${callSid}] 1ª frase (${Date.now() - t0}ms): "${sentence}"`);
            firstSentence = false;
          }
          const audioStream = await elevenlabs.streamTextToSpeech(sentence);
          await new Promise((resolve, reject) => {
            audioStream.pipe(passThrough, { end: false });
            audioStream.on('end', resolve);
            audioStream.on('error', reject);
          });
        },
        session.customSystemPrompt || null
      );

      console.log(`[${callSid}] Cole completo (${Date.now() - t0}ms): "${fullReply}"`);
      conversation.addTurn(callSid, 'assistant', fullReply);
      passThrough.end();
    } catch (err) {
      console.error(`[${callSid}] Error stream:`, err.message);
      passThrough.destroy(err);
    }
  })();

  return token;
}

/**
 * Crea un token de stream para texto estático (silencio/error).
 * Sin Claude — va directo a ElevenLabs.
 */
function createStaticToken(callSid, text) {
  const token = uuidv4();
  const passThrough = new PassThrough();
  pendingStreams.set(token, { stream: passThrough, createdAt: Date.now() });

  ;(async () => {
    try {
      const audioStream = await elevenlabs.streamTextToSpeech(text);
      audioStream.pipe(passThrough);
    } catch (err) {
      console.error(`[${callSid}] Error static stream:`, err.message);
      // Fallback silencioso — passThrough queda vacío, Twilio avanza al Gather
      passThrough.end();
    }
  })();

  return token;
}

// ─── Endpoint de audio en vivo ────────────────────────────────────────────────

router.get('/audio/live/:token', (req, res) => {
  const entry = pendingStreams.get(req.params.token);
  if (!entry) return res.status(404).send('Token expirado');

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Transfer-Encoding', 'chunked');
  entry.stream.pipe(res);
  entry.stream.on('end', () => pendingStreams.delete(req.params.token));
  entry.stream.on('error', () => { res.end(); pendingStreams.delete(req.params.token); });
});

// ─── Inicio de llamada ────────────────────────────────────────────────────────

router.post('/incoming', async (req, res) => {
  const callSid = req.body.CallSid;
  console.log(`[Twilio] Nueva llamada: ${callSid}`);
  const gatherAction = `${BASE_URL}/voice/respond`;

  try {
    const session = conversation.get(callSid);
    const debtorName = session?.debtorInfo?.name;
    const greeting = debtorName ? GREETING_TEMPLATE(debtorName) : UNKNOWN_GREETING;

    if (!session) conversation.create(callSid, null);
    conversation.addTurn(callSid, 'assistant', greeting);

    // Saludo pre-generado (archivo estático) → latencia cero
    if (session?.greetingAudioId) {
      const audioUrl = `${BASE_URL}/audio/${session.greetingAudioId}.mp3`;
      console.log(`[${callSid}] Saludo pre-generado`);
      return res.type('text/xml').send(buildGatherTwiml(audioUrl, gatherAction));
    }

    // Sin pre-generado: streaming del saludo
    const token = createStaticToken(callSid, greeting);
    return res.type('text/xml').send(
      buildGatherTwiml(`${BASE_URL}/voice/audio/live/${token}`, gatherAction)
    );

  } catch (err) {
    console.error(`[${callSid}] /incoming error:`, err.message);
    res.type('text/xml').send(
      buildFallbackTwiml('Hubo un error. Intente más tarde.', gatherAction)
    );
  }
});

// ─── Turno del deudor ─────────────────────────────────────────────────────────

router.post('/respond', (req, res) => {
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult || '';
  const isTimeout = req.query.timeout === '1';
  const gatherAction = `${BASE_URL}/voice/respond`;

  const session = conversation.get(callSid);

  if (!session) {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({ language: 'es-AR' }, 'Error técnico. ¡Hasta luego!');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  // Silencio / timeout — respuesta rápida sin Claude
  if (isTimeout || !speechResult.trim()) {
    const token = createStaticToken(callSid, '¿Seguís ahí? ¿Me escuchás?');
    return res.type('text/xml').send(
      buildGatherTwiml(`${BASE_URL}/voice/audio/live/${token}`, gatherAction)
    );
  }

  console.log(`[${callSid}] Deudor: "${speechResult}"`);
  conversation.addTurn(callSid, 'user', speechResult);

  // 1. Registrar PassThrough ANTES de responder — Twilio puede conectar inmediatamente
  const token = createStreamingToken(callSid, session);
  const audioUrl = `${BASE_URL}/voice/audio/live/${token}`;

  // 2. Devolver TwiML al instante
  res.type('text/xml').send(buildGatherTwiml(audioUrl, gatherAction));

  // 3. El background ya está corriendo: Claude streaming → ElevenLabs → PassThrough
});

// ─── Estado ───────────────────────────────────────────────────────────────────

router.post('/status', (req, res) => {
  const { CallSid, CallStatus, CallDuration } = req.body;
  console.log(`[Twilio] ${CallSid}: ${CallStatus}`);

  if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(CallStatus)) {
    const s = conversation.get(CallSid);
    if (s) {
      console.log(`[${CallSid}] ${s.history.length} turnos — generando reporte`);

      // Generar y enviar reporte en background (no bloquea la respuesta a Twilio)
      generateAndSendReport(s, CallSid, CallStatus, CallDuration)
        .catch(err => console.error(`[${CallSid}] Error enviando reporte:`, err.message));

      conversation.destroy(CallSid);
    }
  }

  res.sendStatus(200);
});

module.exports = router;
