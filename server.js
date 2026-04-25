'use strict';

require('dotenv').config();

const http    = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const path    = require('path');
const fs      = require('fs');

const { handleMediaStream } = require('./src/routes/media-stream');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Validación de variables de entorno ───────────────────────────────────────
const required = [
  'ANTHROPIC_API_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_VOICE_ID',
  'DEEPGRAM_API_KEY',
  'BASE_URL',
];

const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error('❌ Variables de entorno faltantes:', missing.join(', '));
  process.exit(1);
}

// ─── Middlewares ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
app.use('/audio', express.static(TEMP_DIR));

// ─── Rutas HTTP ───────────────────────────────────────────────────────────────
const twilioRoutes = require('./src/routes/twilio');
const callsRoutes  = require('./src/routes/calls');

app.use('/voice', twilioRoutes);
app.use('/api/calls', callsRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Cole Call Center — Media Streams', timestamp: new Date().toISOString() });
});

// ─── HTTP + WebSocket en el mismo puerto ──────────────────────────────────────
const server = http.createServer(app);
const wss    = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/voice/stream') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleMediaStream(ws);
    });
  } else {
    socket.destroy();
  }
});

// ─── Inicio ───────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🤖 Cole Call Center — Media Streams`);
  console.log(`   Puerto        : http://localhost:${PORT}`);
  console.log(`   URL pública   : ${process.env.BASE_URL}`);
  console.log(`   WebSocket     : wss://${process.env.BASE_URL.replace(/^https?:\/\//, '')}/voice/stream`);
  console.log(`   Voice URL     : ${process.env.BASE_URL}/voice/incoming`);
  console.log(`   Status URL    : ${process.env.BASE_URL}/voice/status\n`);
});

module.exports = app;
