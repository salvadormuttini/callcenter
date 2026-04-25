'use strict';

const { DeepgramClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

function createSTTStream({ onTranscript, onSpeechStart, onError }) {
  const client = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY });
  const pendingAudio = [];
  let connRef = null;
  let isOpen = false;
  let isClosed = false;
  let warnedDroppedAfterClose = false;
  let sentChunks = 0;
  let queuedChunks = 0;
  let flushedChunks = 0;
  let deepgramMessages = 0;
  let loggedRawMessage = false;

  function flushPendingAudio() {
    if (!connRef || !isOpen || isClosed) return;
    while (pendingAudio.length) {
      const chunk = pendingAudio.shift();
      try {
        connRef.socket.send(chunk);
        sentChunks += 1;
        flushedChunks += 1;
        console.log(`[Deepgram] chunk enviada (flush) #${sentChunks} | flushed=${flushedChunks} | bytes=${chunk?.length || 0}`);
      } catch (err) {
        console.error('[Deepgram] Error enviando audio:', err?.message || err);
        if (onError) onError(err);
        break;
      }
    }
  }

  const connPromise = client.listen.live({
    model: 'nova-2',
    language: 'es-419',
    encoding: 'mulaw',
    sample_rate: 8000,
    channels: 1,
    punctuate: true,
    interim_results: false,
    endpointing: 300,
  });

  connPromise.then((conn) => {
    connRef = conn;

    conn.on(LiveTranscriptionEvents.Open, () => {
      isOpen = true;
      console.log('[Deepgram] STT conectado');
      flushPendingAudio();
    });

    conn.on(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data?.channel?.alternatives?.[0]?.transcript || '';
      const text = transcript.trim();
      const isFinal = data?.is_final === true;
      console.log(`[Deepgram] transcript | isFinal=${isFinal} | text="${text}"`);
      if (text) onTranscript(text);
    });

    conn.on(LiveTranscriptionEvents.SpeechStarted, () => {
      console.log('[Deepgram] SpeechStarted');
      if (onSpeechStart) onSpeechStart();
    });

    conn.on(LiveTranscriptionEvents.Error, (error) => {
      console.error('[Deepgram] Error:', error);
      if (onError) onError(error);
    });

    conn.on(LiveTranscriptionEvents.Close, () => {
      isOpen = false;
      isClosed = true;
      console.log('[Deepgram] STT desconectado');
    });
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
          connRef.socket.send(audioChunk);
          sentChunks += 1;
          console.log(`[Deepgram] chunk enviada #${sentChunks} | bytes=${audioChunk?.length || 0}`);
        } catch (err) {
          console.error('[Deepgram] Error enviando audio:', err?.message || err);
          if (onError) onError(err);
        }
        return;
      }

      pendingAudio.push(audioChunk);
      queuedChunks += 1;
      console.log(`[Deepgram] chunk en cola #${queuedChunks} | queue_size=${pendingAudio.length} | bytes=${audioChunk?.length || 0}`);
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
