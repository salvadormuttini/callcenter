'use strict';

const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

/**
 * Crea una conexión de STT en tiempo real con Deepgram.
 * Acepta audio μ-law 8kHz directamente (mismo formato que Twilio Media Streams).
 *
 * @param {object} handlers
 * @param {function} handlers.onTranscript  - (text: string) → transcript final
 * @param {function} handlers.onSpeechStart - () → usuario empezó a hablar (para barge-in)
 * @param {function} handlers.onError       - (err) → error de Deepgram
 * @returns Deepgram live connection
 */
function createSTTStream({ onTranscript, onSpeechStart, onError }) {
  const client = createClient(process.env.DEEPGRAM_API_KEY);

  const conn = client.listen.live({
    model: 'nova-2',
    language: 'es-419',      // español latinoamericano
    encoding: 'mulaw',       // acepta mulaw directo de Twilio — sin conversión
    sample_rate: 8000,
    channels: 1,
    punctuate: true,
    interim_results: false,
    endpointing: 300,        // ms de silencio → transcript final
  });

  conn.on(LiveTranscriptionEvents.Open, () => {
    console.log('[Deepgram] STT conectado');
  });

  conn.on(LiveTranscriptionEvents.Transcript, (data) => {
    const text = data.channel?.alternatives?.[0]?.transcript?.trim();
    if (data.is_final && text) {
      onTranscript(text);
    }
  });

  conn.on(LiveTranscriptionEvents.SpeechStarted, () => {
    if (onSpeechStart) onSpeechStart();
  });

  conn.on(LiveTranscriptionEvents.Error, (err) => {
    console.error('[Deepgram] Error:', err?.message || err);
    if (onError) onError(err);
  });

  conn.on(LiveTranscriptionEvents.Close, () => {
    console.log('[Deepgram] STT desconectado');
  });

  return conn;
}

module.exports = { createSTTStream };
