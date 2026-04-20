'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const TEMP_DIR = path.join(__dirname, '../../temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const VOICE_SETTINGS = {
  stability: 0.45,
  similarity_boost: 0.80,
  style: 0.15,
  use_speaker_boost: true,
};

/**
 * Streaming de audio: devuelve Readable stream.
 * optimize_streaming_latency=4 → máxima reducción de latencia ElevenLabs.
 * output_format mp3_22050_32 → chunks más pequeños, primer byte más rápido.
 */
async function streamTextToSpeech(text) {
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const apiKey = process.env.ELEVENLABS_API_KEY;

  const response = await axios({
    method: 'post',
    url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
    params: {
      output_format: 'mp3_22050_32',       // Bitrate bajo → chunks rápidos para telefonía
      optimize_streaming_latency: 4,        // 0-4: máxima reducción de latencia
    },
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    data: {
      text,
      model_id: 'eleven_turbo_v2_5',
      voice_settings: VOICE_SETTINGS,
    },
    responseType: 'stream',
    timeout: 10000,
  });

  return response.data;
}

/**
 * Sin streaming: genera MP3 completo y guarda a disco.
 * Usado solo para el saludo pre-generado (antes de marcar).
 */
async function textToSpeech(text) {
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const apiKey = process.env.ELEVENLABS_API_KEY;

  const response = await axios({
    method: 'post',
    url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    params: { output_format: 'mp3_22050_32' },
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    data: {
      text,
      model_id: 'eleven_turbo_v2_5',
      voice_settings: VOICE_SETTINGS,
    },
    responseType: 'arraybuffer',
    timeout: 8000,
  });

  const audioId = uuidv4();
  const filePath = path.join(TEMP_DIR, `${audioId}.mp3`);
  fs.writeFileSync(filePath, response.data);

  setTimeout(() => { try { fs.unlinkSync(filePath); } catch (_) {} }, 10 * 60 * 1000);

  return audioId;
}

module.exports = { streamTextToSpeech, textToSpeech };
