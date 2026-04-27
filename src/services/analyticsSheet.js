'use strict';

const { google } = require('googleapis');

// Columnas:
// A: CallSid | B: Nombre | C: Teléfono | D: Resultado (BML) | E: PTP
// F: Monto Acordado | G: Fecha Compromiso | H: Objeción Principal
// I: Por Qué No Pagó | J: Momento Clave | K: Recomendación
// L: Fecha Llamada | M: Duración (segundos)
// N: Sentimiento | O: Calidad Llamada (1-10) | P: Score Recupero (1-10)

function buildSheetsClient() {
  const credentialsJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!credentialsJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set');

  const credentials = JSON.parse(credentialsJson);
  credentials.private_key = credentials.private_key
    .replace(/\\n/g, '\n')
    .replace(/\n/g, '\n');

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

function buildRow(data) {
  return [
    data.callSid            || '',
    data.debtorName         || '',
    data.phone              || '',
    data.callResult         || '',   // código BML
    data.ptp                || 'no', // sí / no
    data.amountAgreed       || '',
    data.commitmentDate     || '',
    data.mainObjection      || '',
    data.whyNotPaid         || '',
    data.keyMoment          || '',
    data.recommendation     || '',
    new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }),
    data.duration           || '',
    data.sentiment          || '',
    data.callQuality        ?? '',
    data.recoveryScore      ?? '',
  ];
}

async function appendAnalytics(data) {
  const spreadsheetId = process.env.ANALYTICS_SPREADSHEET_ID;
  const range          = process.env.ANALYTICS_RANGE || 'A:P';

  if (!spreadsheetId) {
    console.warn('[Analytics] Omitido: falta ANALYTICS_SPREADSHEET_ID');
    return { skipped: true };
  }

  console.log(`[Analytics] append → ${spreadsheetId} | ${data.debtorName} | BML: ${data.callResult}`);

  const sheets = buildSheetsClient();
  const response = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [buildRow(data)] },
  });

  const updates = response.data?.updates || {};
  console.log(`[Analytics] OK | updatedRange=${updates.updatedRange} | rows=${updates.updatedRows}`);
  return { ok: true, updates };
}

module.exports = { appendAnalytics };
