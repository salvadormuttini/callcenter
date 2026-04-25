'use strict';

const WebSocket = require('ws');
const conversation = require('../services/conversation');
const claude = require('../services/claude');
const { streamTextToSpeechUlaw } = require('../services/elevenlabs');
const { createSTTStream } = require('../services/deepgram');
const { generateAndSendReport } = require('../services/callReport');
const { GREETING_TEMPLATE, UNKNOWN_GREETING } = require('../config/valentina');

// ─── Helpers ────────────────────────────────────────────────────────────────

function sendMedia(ws, streamSid, chunk) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    event: 'media',
    streamSid,
    media: { payload: Buffer.isBuffer(chunk) ? chunk.toString('base64') : chunk },
  }));
}

function clearAudio(ws, streamSid) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ event: 'clear', streamSid }));
  console.log(`[Stream:${streamSid}] Audio limpiado (barge-in)`);
}

// ─── TTS → Twilio ────────────────────────────────────────────────────────────

async function playTTS(ws, streamSid, text, isCancelled) {
  try {
    const stream = await streamTextToSpeechUlaw(text);
    for await (const chunk of stream) {
      if (isCancelled()) return;
      sendMedia(ws, streamSid, chunk);
    }
  } catch (err) {
    console.error(`[TTS] Error en "${text.slice(0, 30)}":`, err.message);
  }
}

// ─── Respuesta de Cole (Claude → ElevenLabs → Twilio) ────────────────────────

async function respondWithCole(ws, streamSid, callSid, session, cancelToken, t0) {
  let firstSentence = true;

  try {
    const fullReply = await claude.streamBySentence(
      session.history,
      session.debtorInfo,
      async (sentence) => {
        if (cancelToken.cancelled) return;
        if (firstSentence) {
          console.log(`[${callSid}] 1ª frase | webhook→audio: ${Date.now() - t0}ms | "${sentence}"`);
          firstSentence = false;
        }
        await playTTS(ws, streamSid, sentence, () => cancelToken.cancelled);
      },
      session.customSystemPrompt || null
    );

    if (!cancelToken.cancelled) {
      conversation.addTurn(callSid, 'assistant', fullReply);
      console.log(`[${callSid}] Cole completo: "${fullReply}"`);
    }
  } catch (err) {
    console.error(`[${callSid}] Error respondWithCole:`, err.message);
  }
}

// ─── Handler principal de Media Streams ──────────────────────────────────────

function handleMediaStream(ws) {
  let streamSid  = null;
  let callSid    = null;
  let session    = null;
  let dgConn     = null;

  // Cola de respuestas — evita que dos respuestas se superpongan
  let responseChain = Promise.resolve();
  let currentCancel = { cancelled: false };

  function cancelCurrentResponse() {
    currentCancel.cancelled = true;
    currentCancel = { cancelled: false };
  }

  function enqueueResponse(text, t0) {
    cancelCurrentResponse();
    const token = currentCancel;

    responseChain = responseChain.then(async () => {
      if (token.cancelled) return;
      await respondWithCole(ws, streamSid, callSid, session, token, t0);
    }).catch(err => console.error(`[${callSid}] responseChain error:`, err.message));
  }

  // ── Eventos del WebSocket ──────────────────────────────────────────────────

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.event) {

      case 'connected':
        console.log('[MediaStream] WebSocket conectado');
        break;

      case 'start': {
        streamSid = msg.start.streamSid;
        callSid   = msg.start.callSid;
        session   = conversation.get(callSid);

        if (!session) {
          conversation.create(callSid, null);
          session = conversation.get(callSid);
        }

        console.log(`[MediaStream] Start | callSid: ${callSid} | streamSid: ${streamSid}`);

        // Iniciar Deepgram STT
        dgConn = createSTTStream({
          onSpeechStart: () => {
            // Barge-in: usuario empieza a hablar → limpiar audio de Cole
            clearAudio(ws, streamSid);
            cancelCurrentResponse();
          },

          onTranscript: (text) => {
            console.log(`[${callSid}] STT: "${text}"`);
            const t0 = Date.now();
            conversation.addTurn(callSid, 'user', text);
            enqueueResponse(text, t0);
          },

          onError: (err) => {
            console.error(`[${callSid}] Deepgram error:`, err?.message || err);
          },
        });

        // Reproducir saludo
        const debtorName = session?.debtorInfo?.name;
        const greeting = debtorName ? GREETING_TEMPLATE(debtorName) : UNKNOWN_GREETING;
        conversation.addTurn(callSid, 'assistant', greeting);

        const greetToken = { cancelled: false };
        currentCancel = greetToken;
        await playTTS(ws, streamSid, greeting, () => greetToken.cancelled);
        break;
      }

      case 'media': {
        // Solo audio inbound (voz del llamado) → Deepgram
        if (msg.media.track === 'inbound' && dgConn) {
          const audio = Buffer.from(msg.media.payload, 'base64');
          try { dgConn.send(audio); } catch (_) {}
        }
        break;
      }

      case 'stop': {
        console.log(`[${callSid}] Media stream terminado`);
        cancelCurrentResponse();
        if (dgConn) { try { dgConn.finish(); } catch (_) {} dgConn = null; }
        break;
      }
    }
  });

  ws.on('close', () => {
    console.log(`[MediaStream] WS cerrado | callSid: ${callSid}`);
    cancelCurrentResponse();
    if (dgConn) { try { dgConn.finish(); } catch (_) {} }
  });

  ws.on('error', (err) => {
    console.error(`[MediaStream] WS error (${callSid}):`, err.message);
    if (dgConn) { try { dgConn.finish(); } catch (_) {} }
  });
}

module.exports = { handleMediaStream };
