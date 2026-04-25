'use strict';

const express  = require('express');
const router   = express.Router();
const twilio   = require('twilio');
const { getSheetRows } = require('../services/googleSheets');
const conversation = require('../services/conversation');

const SHEET_ID = '15kL4w4-Qj2j0ZeApuoroe_aHk9NsBrQIL1JYYLIiRTc';
const BASE_URL = () => process.env.BASE_URL;

// ─── GET /api/calls/deudores/:debtorName ─────────────────────────────────────

router.get('/:debtorName', async (req, res) => {
  const { debtorName } = req.params;

  try {
    // 1. Read sheet via shared service (inherits fixed auth + NODE_OPTIONS)
    const rows = await getSheetRows(SHEET_ID, 'A:G');

    // 2. Find header row and locate debtor
    const headerIdx = rows.findIndex(r => (r[0] || '').toUpperCase() === 'NOMBRE');
    if (headerIdx === -1) return res.status(500).json({ error: 'No se encontró la fila de headers en el Sheet' });

    const dataRows = rows.slice(headerIdx + 1);
    const row = dataRows.find(r => (r[0] || '').trim() === debtorName.trim());

    if (!row) {
      return res.status(404).json({ error: `Deudor "${debtorName}" no encontrado en el Sheet` });
    }

    // 3. Extract fields — A=Nombre B=Teléfono C=Monto D=Estado E=Resultado F=Fecha G=Intentos
    const name       = (row[0] || '').trim();
    const phone      = (row[1] || '').trim();
    const amount     = parseFloat((row[2] || '0').replace(/[^0-9.]/g, '')) || 0;
    const daysOverdue = parseInt(row[3]) || 0;

    if (!phone.match(/^\+\d{10,15}$/)) {
      return res.status(400).json({ error: `Teléfono "${phone}" no está en formato E.164 (+549...)` });
    }

    // 4. Initiate Twilio call
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

    const call = await client.calls.create({
      to: phone,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `${BASE_URL()}/voice/incoming`,
      statusCallback: `${BASE_URL()}/voice/status`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      timeout: 30,
    });

    conversation.create(call.sid, { name, amount, daysOverdue, phone });
    console.log(`[Deudores] Llamada iniciada → ${name} (${phone}) | SID: ${call.sid}`);

    // 5. Return result
    res.json({
      success: true,
      callSid: call.sid,
      status:  call.status,
      name,
      phone,
      amount,
      daysOverdue,
    });

  } catch (err) {
    console.error('[Deudores] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
