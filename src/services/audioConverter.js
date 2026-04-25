'use strict';

// μ-law decode lookup table (256 entries, μ-law byte → 16-bit linear PCM)
const MULAW_DECODE = new Int16Array(256);
(function buildTable() {
  for (let i = 0; i < 256; i++) {
    const byte = ~i;
    const sign     = byte & 0x80;
    const exp      = (byte >> 4) & 0x07;
    const mantissa = byte & 0x0F;
    let sample = ((mantissa << 3) + 0x84) << exp;
    sample -= 0x84;
    MULAW_DECODE[i] = sign ? -sample : sample;
  }
})();

/**
 * Convierte un Buffer de μ-law a PCM 16-bit little-endian.
 * Útil para debug o procesamiento downstream.
 */
function mulawToPCM16(mulawBuf) {
  const pcm = Buffer.alloc(mulawBuf.length * 2);
  for (let i = 0; i < mulawBuf.length; i++) {
    pcm.writeInt16LE(MULAW_DECODE[mulawBuf[i] & 0xFF], i * 2);
  }
  return pcm;
}

/**
 * En este stack, ElevenLabs entrega ulaw_8000 directo
 * y Deepgram acepta mulaw nativo → esta función es de utilidad/debug.
 */
module.exports = { mulawToPCM16 };
