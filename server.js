'use strict';

require('dotenv').config();

const http    = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const path    = require('path');
const fs      = require('fs');

const { handleMediaStream } = require('./src/routes/media-stream');
const { startProcessor }   = require('./src/services/retryQueue');
const { log, readLastLines } = require('./src/services/logger');
const { Resend }             = require('resend');

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
app.use(express.static(path.join(__dirname, 'src/public')));

const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
app.use('/audio', express.static(TEMP_DIR));

// ─── Rutas HTTP ───────────────────────────────────────────────────────────────
const twilioRoutes  = require('./src/routes/twilio');
const callsRoutes   = require('./src/routes/calls');
const deudoresRoutes = require('./src/routes/deudores');

app.use('/voice', twilioRoutes);
app.use('/api/deudores', deudoresRoutes);
// ─── Test endpoints ───────────────────────────────────────────────────────────

app.get('/api/test/runtime', (req, res) => {
  res.json({
    node: process.version,
    openssl: process.versions.openssl,
    nodeOptions: process.env.NODE_OPTIONS || null,
  });
});

app.get('/debug/routes-version', (req, res) => {
  res.json({ ok: true, version: 'v1', time: new Date().toISOString() });
});

app.post('/api/test/twilio', async (req, res) => {
  try {
    const twilio = require('twilio');
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const account = await client.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
    res.json({ ok: true, account: account.sid, status: account.status });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/test/sheets', async (req, res) => {
  try {
    const { appendCallReport } = require('./src/services/googleSheets');
    await appendCallReport({ debtorName: 'TEST', callResult: 'TEST', notes: 'test desde endpoint' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/test/claude', async (req, res) => {
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Di "ok"' }],
    });
    res.json({ ok: true, response: msg.content[0]?.text });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/test/elevenlabs', async (req, res) => {
  try {
    const axios = require('axios');
    const r = await axios.get('https://api.elevenlabs.io/v1/user', {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
      timeout: 5000,
    });
    res.json({ ok: true, tier: r.data?.subscription?.tier });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/test/deepgram', async (req, res) => {
  try {
    const axios = require('axios');
    const r = await axios.get('https://api.deepgram.com/v1/projects', {
      headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
      timeout: 5000,
    });
    res.json({ ok: true, projects: r.data?.projects?.length ?? 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.use('/api/calls', callsRoutes);

app.get('/api/logs', (req, res) => {
  const lines = readLastLines(50);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(lines.join('\n') || '(sin logs)');
});

app.get('/api/retries', (req, res) => {
  const { queue } = require('./src/services/retryQueue');
  res.json({ pending: queue.length, entries: queue.map(e => ({ phone: e.phone, retryAt: new Date(e.retryAt).toISOString(), attempts: e.attempts })) });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Cole Call Center — Media Streams',
    timestamp: new Date().toISOString(),
    services: {
      twilio:     !!process.env.TWILIO_ACCOUNT_SID,
      sheets:     !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
      claude:     !!process.env.ANTHROPIC_API_KEY,
      elevenlabs: !!process.env.ELEVENLABS_API_KEY,
      deepgram:   !!process.env.DEEPGRAM_API_KEY,
    },
  });
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
// ─── Health monitoring ────────────────────────────────────────────────────────
const HEALTH_INTERVAL = 30 * 60 * 1000; // 30 minutes

async function runHealthCheck() {
  const axios   = require('axios');
  const twilio  = require('twilio');
  const results = {};

  // Twilio
  try {
    const c = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await c.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
    results.twilio = 'ok';
  } catch (e) { results.twilio = e.message; }

  // ElevenLabs
  try {
    await axios.get('https://api.elevenlabs.io/v1/user', {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }, timeout: 8000,
    });
    results.elevenlabs = 'ok';
  } catch (e) { results.elevenlabs = e.message; }

  // Deepgram
  try {
    await axios.get('https://api.deepgram.com/v1/projects', {
      headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` }, timeout: 8000,
    });
    results.deepgram = 'ok';
  } catch (e) { results.deepgram = e.message; }

  // Google Sheets (lightweight: check env only — full auth check is too expensive)
  results.sheets = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? 'ok (env set)' : 'missing env';

  const failed = Object.entries(results).filter(([, v]) => v !== 'ok' && !v.startsWith('ok'));

  if (failed.length > 0) {
    log.warn('Health', 'Servicios con fallo', Object.fromEntries(failed));
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from:    'Cole Call Center <onboarding@resend.dev>',
        to:      'salvadormuttini@gmail.com',
        subject: `🚨 Cole — ${failed.length} servicio(s) con fallo`,
        html: `
          <h2>🚨 Alerta de salud — Cole</h2>
          <p><b>Timestamp:</b> ${new Date().toISOString()}</p>
          <ul>${failed.map(([svc, err]) => `<li><b>${svc}:</b> ${err}</li>`).join('')}</ul>
          <p>Revisá los logs en <code>GET /api/logs</code>.</p>
        `,
      });
    } catch (alertErr) {
      log.error('Health', 'No se pudo enviar alerta', { error: alertErr.message });
    }
  } else {
    log.info('Health', 'Todos los servicios OK', results);
  }
}

startProcessor();
setInterval(runHealthCheck, HEALTH_INTERVAL);

server.listen(PORT, () => {
  console.log(`\n🤖 Cole Call Center — Media Streams`);
  console.log(`   Puerto        : http://localhost:${PORT}`);
  console.log(`   URL pública   : ${process.env.BASE_URL}`);
  console.log(`   WebSocket     : wss://${process.env.BASE_URL.replace(/^https?:\/\//, '')}/voice/stream`);
  console.log(`   Voice URL     : ${process.env.BASE_URL}/voice/incoming`);
  console.log(`   Status URL    : ${process.env.BASE_URL}/voice/status\n`);
});

module.exports = app;
