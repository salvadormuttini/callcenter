'use strict';

const { DeepgramClient } = require('@deepgram/sdk');

function createSTTStream({ onTranscript, onSpeechStart, onError }) {
  const client = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY });
  const pendingAudio = [];
  let connRef = null;
  let isOpen = false;
  let isClosed = false;
  let warnedDroppedAfterClose = false;

  function flushPendingAudio() {
    if (!connRef || !isOpen || isClosed) return;
    while (pendingAudio.length) {
      const chunk = pendingAudio.shift();
      try {
        connRef.sendMedia(chunk);
      } catch (err) {
        console.error('[Deepgram] Error enviando audio:', err?.message || err);
        if (onError) onError(err);
        break;
      }
    }
  }

  const connPromise = client.listen.v1.connect({
    model: 'nova-2',
    language: 'es-419',
    encoding: 'mulaw',
    sample_rate: 8000,
    channels: 1,
    punctuate: true,
    interim_results: false,
    endpointing: 300,
    Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
  });

  connPromise.then((conn) => {
    connRef = conn;

    conn.on('open', () => {
      isOpen = true;
      console.log('[Deepgram] STT conectado');
      flushPendingAudio();
    });

    conn.on('message', (data) => {
      if (data?.type === 'Results') {
        const text = data.channel?.alternatives?.[0]?.transcript?.trim();
        if (data.is_final && text) onTranscript(text);
      } else if (data?.type === 'SpeechStarted') {
        if (onSpeechStart) onSpeechStart();
      }
    });

    conn.on('error', (err) => {
      console.error('[Deepgram] Error:', err?.message || err);
      if (onError) onError(err);
    });

    conn.on('close', () => {
      isOpen = false;
      isClosed = true;
      console.log('[Deepgram] STT desconectado');
    });

    conn.connect();
  }).catch((err) => {
    isClosed = true;
    pendingAudio.length = 0;
    console.error('[Deepgram] Error inicializando STT:', err?.message || err);
    if (onError) onError(err);
  });

  return {
    send(audioChunk) {
      if (isClosed) {
        if (!warnedDroppedAfterClose) {
          console.warn('[Deepgram] Audio descartado: STT ya cerrado');
          warnedDroppedAfterClose = true;
        }
        return;
      }

      if (isOpen && connRef) {
        try {
          connRef.sendMedia(audioChunk);
        } catch (err) {
          console.error('[Deepgram] Error enviando audio:', err?.message || err);
          if (onError) onError(err);
        }
        return;
      }

      pendingAudio.push(audioChunk);
    },

    finish() {
      isClosed = true;
      pendingAudio.length = 0;
      connPromise.then((conn) => {
        isOpen = false;
        try { conn.sendCloseStream({ type: 'CloseStream' }); } catch (_) {}
        conn.close();
      }).catch(() => {});
    },
  };
}

module.exports = { createSTTStream };
