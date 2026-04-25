'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { google } = require('googleapis');
const axios = require('axios');

const SHEET_ID = '15kL4w4-Qj2j0ZeApuoroe_aHk9NsBrQIL1JYYLIiRTc';
const TARGET_NAME = 'Salvador Mutttini'; // nombre exacto en el Sheet (3 t)
const SERVER_URL = process.env.BASE_URL || 'http://localhost:3000';
const POLL_INTERVAL_MS = 6000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos máximo

// Columnas: A=Nombre B=Teléfono C=Monto D=Estado E=Resultado F=Fecha llamada G=Intentos

function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('Falta GOOGLE_SERVICE_ACCOUNT_JSON en .env');
  const credentials = JSON.parse(raw);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function readSheet(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'A:G',
  });
  return res.data.values || [];
}

async function updateSheetRow(sheets, rowNumber, estado, resultado, intentos) {
  const fecha = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `D${rowNumber}:G${rowNumber}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[estado, resultado, fecha, intentos]] },
  });
}

async function pollCallStatus(callSid) {
  const start = Date.now();
  const terminal = ['completed', 'failed', 'busy', 'no-answer', 'canceled'];

  console.log(`[Poll] Esperando resultado de la llamada ${callSid}...`);

  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const res = await axios.get(`${SERVER_URL}/api/calls/${callSid}`);
      const { status, duration } = res.data;
      console.log(`[Poll] Estado: ${status}`);
      if (terminal.includes(status)) return { status, duration };
    } catch (err) {
      console.warn(`[Poll] Error consultando estado: ${err.message}`);
    }
  }

  throw new Error('Timeout esperando fin de llamada (5 minutos)');
}

async function main() {
  // 1. Auth y cliente Sheets
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  // 2. Leer sheet
  console.log('[Sheet] Leyendo Google Sheet...');
  const rows = await readSheet(sheets);
  if (rows.length < 2) throw new Error('El Sheet está vacío o no tiene datos');

  // Detectar fila de headers (la que tiene "NOMBRE" o "Nombre")
  const headerRowIndex = rows.findIndex(r => (r[0] || '').toUpperCase() === 'NOMBRE');
  if (headerRowIndex === -1) throw new Error('No se encontró la fila de headers (NOMBRE)');

  // 3. Buscar únicamente Salvador Muttini
  let targetRowIndex = -1;
  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    if ((rows[i][0] || '').trim() === TARGET_NAME) {
      targetRowIndex = i;
      break;
    }
  }

  if (targetRowIndex === -1) throw new Error(`No se encontró la fila con Nombre = "${TARGET_NAME}"`);

  const row = rows[targetRowIndex];
  const sheetRowNumber = targetRowIndex + 1; // 1-indexed para la API
  const estado = (row[3] || '').trim();
  const phone = (row[1] || '').trim();
  const amount = parseFloat((row[2] || '').replace(/[^0-9.]/g, '')) || 100000;
  const intentos = parseInt(row[6]) || 0;

  console.log(`[Sheet] Fila encontrada: ${TARGET_NAME} | Tel: ${phone} | Monto: $${amount} | Estado: ${estado}`);

  // 4. Validar estado
  if (!['PENDIENTE', 'Pendiente', 'pendiente'].includes(estado)) {
    throw new Error(`Estado es "${estado}" — se requiere PENDIENTE para llamar. Abortando.`);
  }

  // 5. Validar teléfono
  if (!phone.match(/^\+\d{10,15}$/)) {
    throw new Error(`Teléfono "${phone}" no está en formato E.164 (ej: +5491131427982). Corregilo en el Sheet.`);
  }

  // 6. Iniciar llamada
  console.log(`[Call] Iniciando llamada a ${TARGET_NAME} (${phone})...`);
  let callSid;
  try {
    const res = await axios.post(`${SERVER_URL}/api/calls/outbound`, {
      to: phone,
      debtor: {
        name: TARGET_NAME,
        amount,
        daysOverdue: 0,
        accountId: 'TEST-SHEET-001',
      },
    });
    callSid = res.data.callSid;
    console.log(`[Call] Llamada iniciada. SID: ${callSid}`);
  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    await updateSheetRow(sheets, sheetRowNumber, 'ERROR', `Error al iniciar llamada: ${msg}`, intentos + 1);
    throw new Error(`Error iniciando llamada: ${msg}`);
  }

  // 7. Esperar resultado
  let callStatus, duration;
  try {
    ({ status: callStatus, duration } = await pollCallStatus(callSid));
  } catch (err) {
    await updateSheetRow(sheets, sheetRowNumber, 'ERROR', `Timeout: ${err.message}`, intentos + 1);
    throw err;
  }

  // 8. Actualizar Sheet
  const isOk = callStatus === 'completed';
  const resultado = isOk
    ? `Llamada completada (${duration || 0}s) | SID: ${callSid}`
    : `Llamada ${callStatus} | SID: ${callSid}`;
  const nuevoEstado = isOk ? 'COMPLETADO' : 'ERROR';

  console.log(`[Sheet] Actualizando fila ${sheetRowNumber}: ${nuevoEstado} — ${resultado}`);
  await updateSheetRow(sheets, sheetRowNumber, nuevoEstado, resultado, intentos + 1);

  console.log(`\n✅ Prueba finalizada.`);
  console.log(`   Deudor  : ${TARGET_NAME}`);
  console.log(`   Estado  : ${nuevoEstado}`);
  console.log(`   Resultado: ${resultado}`);
}

main().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
