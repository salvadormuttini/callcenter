'use strict';

const { DeepgramClient } = require('@deepgram/sdk');

/**
 * Crea una conexión de STT en tiempo real con Deepgram.
 * Acepta audio μ-law 8kHz directamente (mismo formato que Twilio Media Streams).
 */
function createSTTStream({ onTranscript, onSpeechStart, onError }) {
  const client = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY });

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
    conn.on('open', () => {
      console.log('[Deepgram] STT conectado');
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
      console.log('[Deepgram] STT desconectado');
    });

    conn.connect();
  }).catch((err) => {
    console.error('[Deepgram] Error inicializando STT:', err?.message || err);
    if (onError) onError(err);
  });

  return {
    send(audioChunk) {
      connPromise.then((conn) => conn.sendMedia(audioChunk)).catch((err) => {
        console.error('[Deepgram] Error enviando audio:', err?.message || err);
        if (onError) onError(err);
      });
    },

    finish() {
      connPromise.then((conn) => {
        try { conn.sendCloseStream({ type: 'CloseStream' }); } catch (_) {}
        conn.close();
      }).catch(() => {});
    },
  };
}

module.exports = { createSTTStream };
