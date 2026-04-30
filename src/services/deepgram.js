'use strict';

const { DeepgramClient } = require('@deepgram/sdk');
const { log } = require('./logger');

const DG_OPTIONS = {
  model:           'nova-2',
  language:        'es-419',
  encoding:        'mulaw',
  sample_rate:     8000,
  channels:        1,
  punctuate:       true,
  interim_results: false,
  endpointing:     300,
};

function createSTTStream({ onTranscript, onSpeechStart, onError }) {
  log.info('Deepgram', 'createSTTStream iniciado');

  const client       = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY });
  const pendingAudio = [];
  let connRef        = null;
  let isOpen         = false;
  let isClosed       = false;        // intentionally closed by finish()
  let reconnectDone  = false;        // only one reconnect attempt allowed
  let warnedDropped  = false;
  let sentChunks     = 0;

  function flushPendingAudio() {
    if (!connRef || !isOpen || isClosed) return;
    while (pendingAudio.length) {
      const chunk = pendingAudio.shift();
      try {
        connRef.socket.send(chunk);
        sentChunks++;
      } catch (err) {
        log.error('Deepgram', 'Error enviando audio en flush', { error: err.message });
        if (onError) onError(err);
        break;
      }
    }
  }

  function attachHandlers(conn, isReconnect = false) {
    conn.on('open', () => {
      isOpen = true;
      log.info('Deepgram', isReconnect ? 'STT reconectado' : 'STT conectado');
      flushPendingAudio();
    });

    conn.on('message', (data) => {
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch { return; }
      }
      if (Buffer.isBuffer(data)) {
        try { data = JSON.parse(data.toString()); } catch { return; }
      }

      const type = data?.type?.toLowerCase() || '';
      if (type === 'results') {
        const text = (data?.channel?.alternatives?.[0]?.transcript || '').trim();
        if (text) { log.info('Deepgram', `STT: ${text}`); onTranscript(text); }
      } else if (type === 'speechstarted') {
        if (onSpeechStart) onSpeechStart();
      }
    });

    conn.on('error', (err) => {
      log.error('Deepgram', 'Error de WebSocket', { error: err?.message });
      if (onError) onError(err);
    });

    conn.on('close', () => {
      isOpen = false;
      log.info('Deepgram', 'STT desconectado' + (isClosed ? ' (intencional)' : ' (inesperado)'));

      if (isClosed) return; // finish() was called — expected close

      if (!reconnectDone) {
        reconnectDone = true;
        log.warn('Deepgram', 'Intentando reconexión...');
        attemptReconnect();
      } else {
        // Second drop after reconnect — fatal
        log.error('Deepgram', 'Reconexión también cayó — finalizando llamada');
        if (onError) onError({
          fatal: true,
          message: 'Tuve un problema técnico. Te vuelvo a llamar pronto.',
        });
      }
    });

    conn.connect();
  }

  async function attemptReconnect() {
    try {
      const newConn = await client.listen.v1.connect({
        ...DG_OPTIONS,
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
      });
      connRef = newConn;
      attachHandlers(newConn, true);
    } catch (err) {
      log.error('Deepgram', 'Reconexión falló', { error: err.message });
      if (onError) onError({
        fatal: true,
        message: 'Tuve un problema técnico. Te vuelvo a llamar pronto.',
      });
    }
  }

  // Initial connection
  client.listen.v1.connect({
    ...DG_OPTIONS,
    Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
  }).then((conn) => {
    connRef = conn;
    attachHandlers(conn, false);
  }).catch((err) => {
    isClosed = true;
    pendingAudio.length = 0;
    log.error('Deepgram', 'Error inicializando STT', { error: err.message });
    if (onError) onError(err);
  });

  return {
    send(audioChunk) {
      if (isClosed) {
        if (!warnedDropped) {
          log.warn('Deepgram', 'Audio descartado: STT cerrado');
          warnedDropped = true;
        }
        return;
      }
      if (isOpen && connRef) {
        try {
          connRef.socket.send(audioChunk);
          sentChunks++;
        } catch (err) {
          log.error('Deepgram', 'Error enviando chunk', { error: err.message });
          if (onError) onError(err);
        }
        return;
      }
      pendingAudio.push(audioChunk);
    },

    finish() {
      isClosed = true;
      pendingAudio.length = 0;
      if (connRef) {
        isOpen = false;
        try { connRef.sendCloseStream({ type: 'CloseStream' }); } catch (_) {}
        try { connRef.close(); } catch (_) {}
      }
    },
  };
}

module.exports = { createSTTStream };
