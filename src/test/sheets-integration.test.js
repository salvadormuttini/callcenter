'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { appendCallReport } = require('../services/googleSheets');
const { generateAndSendReport } = require('../services/callReport');

// ─── Test 1: appendCallReport directo ────────────────────────────────────────
// Bypasses Claude, Twilio, Deepgram — sólo prueba auth + write a Google Sheets.

async function testDirectAppend() {
  console.log('\n━━━ TEST 1: appendCallReport directo ━━━');

  const reportData = {
    debtorName: 'Salvador Muttini (TEST)',
    callSid: 'CA_TEST_' + Date.now(),
    semaphore: 'verde',
    categorizacion: 'PROM',
    result: 'Acordó pago de cien mil pesos para el viernes [TEST]',
    summary: 'El deudor reconoció la deuda y prometió pagar el viernes. Actitud colaborativa. [TEST LOCAL]',
    keyMoments: ['Reconoció la deuda', 'Prometió pagar el viernes', 'Pidió confirmación por mail'],
    nextAction: 'Llamar el viernes para confirmar el pago [TEST]',
  };

  try {
    const result = await appendCallReport(reportData);
    console.log('✅ TEST 1 PASÓ — fila agregada a Google Sheets');
    console.log('   result:', result);
    return true;
  } catch (err) {
    console.error('❌ TEST 1 FALLÓ:', err.message);
    return false;
  }
}

// ─── Test 2: generateAndSendReport con sesión simulada ────────────────────────
// Usa Claude real para analizar una conversación falsa, luego escribe a Sheets.
// Simula el transcript de Deepgram: "Hola, tengo un problema de dinero"

async function testFullReportFlow() {
  console.log('\n━━━ TEST 2: generateAndSendReport (Claude + Sheets) ━━━');

  const fakeSession = {
    debtorInfo: {
      name: 'Salvador Muttini',
      amount: 100000,
      daysOverdue: 30,
      accountId: 'TEST-001',
    },
    history: [
      { role: 'assistant', content: 'Hola Salvador Muttini, soy Cole, te llamo por un saldo pendiente.' },
      { role: 'user',      content: 'Hola, tengo un problema de dinero.' },   // transcript de Deepgram simulado
      { role: 'assistant', content: '¿Estabas al tanto de este saldo?' },
      { role: 'user',      content: 'Sí, lo sé, pero estoy muy apretado este mes.' },
      { role: 'assistant', content: '¿Cuánto podrías pagar por mes sin complicarte?' },
      { role: 'user',      content: 'Tal vez veinte mil pesos por mes.' },
      { role: 'assistant', content: 'Perfecto. Entonces quedamos en veinte mil pesos por mes. Primer pago este viernes. Te mando mail con todo. ¿ok?' },
      { role: 'user',      content: 'Sí, está bien.' },
    ],
  };

  const fakeCallSid = 'CA_TEST_FULL_' + Date.now();

  try {
    await generateAndSendReport(fakeSession, fakeCallSid, 'completed');
    console.log('✅ TEST 2 PASÓ — Claude analizó + reporte enviado');
    return true;
  } catch (err) {
    console.error('❌ TEST 2 FALLÓ:', err.message);
    return false;
  }
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('🧪 Iniciando tests de integración Google Sheets');
  console.log('   SPREADSHEET_ID:', process.env.GOOGLE_SHEETS_SPREADSHEET_ID);
  console.log('   RANGE:         ', process.env.GOOGLE_SHEETS_RANGE || 'Sheet1!A:I');
  console.log('   CREDENTIALS:   ', process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? `env var (${process.env.GOOGLE_SERVICE_ACCOUNT_JSON.length} chars)` : 'file fallback');

  const t1 = await testDirectAppend();

  if (t1) {
    // Solo correr test 2 si test 1 pasó (confirma que Sheets funciona)
    await testFullReportFlow();
  } else {
    console.log('\n⚠️  Test 2 saltado — arreglá primero la conexión a Sheets (Test 1)');
  }

  console.log('\n━━━ Tests finalizados ━━━\n');
}

main().catch(err => {
  console.error('Runner error:', err.message);
  process.exit(1);
});
