'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Validación de variables de entorno ───────────────────────────────────────
const required = [
  'ANTHROPIC_API_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_VOICE_ID',
  'BASE_URL',
];

const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error('❌ Variables de entorno faltantes:', missing.join(', '));
  console.error('   Copiá .env.example a .env y completá los valores.');
  process.exit(1);
}

// ─── Middlewares ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Servir archivos de audio generados por ElevenLabs
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
app.use('/audio', express.static(TEMP_DIR));

// ─── Rutas ────────────────────────────────────────────────────────────────────
const twilioRoutes = require('./src/routes/twilio');
const callsRoutes = require('./src/routes/calls');

app.use('/voice', twilioRoutes);
app.use('/api/calls', callsRoutes);

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Cole Call Center',
    timestamp: new Date().toISOString(),
  });
});

// ─── Inicio ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🤖 Cole Call Center iniciada`);
  console.log(`   Puerto local  : http://localhost:${PORT}`);
  console.log(`   URL pública   : ${process.env.BASE_URL}`);
  console.log(`   Empresa       : ${process.env.COMPANY_NAME || 'Financiera Sur'}`);
  console.log(`\n   Webhooks Twilio configurar en:`);
  console.log(`   Voice URL     : ${process.env.BASE_URL}/voice/incoming`);
  console.log(`   Status URL    : ${process.env.BASE_URL}/voice/status`);
  console.log(`\n   API para iniciar llamadas:`);
  console.log(`   POST ${process.env.BASE_URL}/api/calls/outbound\n`);
});

module.exports = app;
