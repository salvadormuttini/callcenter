'use strict';

const { DeepgramClient } = require('@deepgram/sdk');

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
      if (typeof data === 'string') {
        try { data = JSON.parse(data); }
        catch (e) { console.error('[Deepgram] Parse error:', e.message); return; }
      }
      if (Buffer.isBuffer(data)) {
        try { data = JSON.parse(data.toString()); }
        catch (e) { console.error('[Deepgram] Buffer parse error:', e.message); return; }
      }

      const messageType = data?.type?.toLowerCase() || '';

      if (messageType === 'results') {
        const transcript = data?.channel?.alternatives?.[0]?.transcript || '';
        const text = transcript.trim();
        if (text) {
          console.log('[Deepgram] STT:', text);
          onTranscript(text);
        }
      } else if (messageType === 'speechstarted') {
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
