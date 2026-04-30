'use strict';

const axios  = require('axios');
const fs     = require('fs');
const path   = require('path');
const { Readable } = require('stream');
const { v4: uuidv4 } = require('uuid');
const { log } = require('./logger');

const TEMP_DIR = path.join(__dirname, '../../temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const VOICE_SETTINGS = {
  stability:        0.45,
  similarity_boost: 0.80,
  style:            0.15,
  use_speaker_boost: true,
};

// μ-law silence: 0x7F = encoded silence at 8000 Hz
// Returns a Readable stream with ~2 s of silence so the call stays alive
function silenceStream(durationMs = 2000) {
  const bytes  = Math.floor(8000 * (durationMs / 1000));
  const buffer = Buffer.alloc(bytes, 0x7f);
  return Readable.from((function* () { yield buffer; })());
}

async function streamTextToSpeechUlaw(text) {
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const apiKey  = process.env.ELEVENLABS_API_KEY;

  try {
    const response = await axios({
      method: 'post',
      url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      params: { output_format: 'ulaw_8000', optimize_streaming_latency: 4 },
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      data: { text, model_id: 'eleven_turbo_v2_5', voice_settings: VOICE_SETTINGS },
      responseType: 'stream',
      timeout: 10000,
    });
    return response.data;
  } catch (err) {
    log.error('ElevenLabs', 'streamTextToSpeechUlaw falló — usando silencio de fallback', {
      error: err.message,
      status: err.response?.status,
    });
    return silenceStream(2000);
  }
}

async function streamTextToSpeech(text) {
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const apiKey  = process.env.ELEVENLABS_API_KEY;

  try {
    const response = await axios({
      method: 'post',
      url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      params: { output_format: 'mp3_22050_32', optimize_streaming_latency: 4 },
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      data: { text, model_id: 'eleven_turbo_v2_5', voice_settings: VOICE_SETTINGS },
      responseType: 'stream',
      timeout: 10000,
    });
    return response.data;
  } catch (err) {
    log.error('ElevenLabs', 'streamTextToSpeech falló', { error: err.message });
    throw err;
  }
}

async function textToSpeech(text) {
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const apiKey  = process.env.ELEVENLABS_API_KEY;

  try {
    const response = await axios({
      method: 'post',
      url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      params: { output_format: 'mp3_22050_32' },
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      data: { text, model_id: 'eleven_turbo_v2_5', voice_settings: VOICE_SETTINGS },
      responseType: 'arraybuffer',
      timeout: 8000,
    });

    const audioId  = uuidv4();
    const filePath = path.join(TEMP_DIR, `${audioId}.mp3`);
    fs.writeFileSync(filePath, response.data);
    setTimeout(() => { try { fs.unlinkSync(filePath); } catch (_) {} }, 10 * 60 * 1000);
    return audioId;
  } catch (err) {
    log.error('ElevenLabs', 'textToSpeech falló', { error: err.message, status: err.response?.status });
    throw new Error(`ElevenLabs TTS falló: ${err.response?.status ?? err.message}`);
  }
}

module.exports = { streamTextToSpeech, streamTextToSpeechUlaw, textToSpeech };
