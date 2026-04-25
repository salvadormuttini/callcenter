'use strict';

const fs = require('fs');
const { google } = require('googleapis');

function getSheetsConfig() {
  return {
    credentialsJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
    range: process.env.GOOGLE_SHEETS_RANGE || 'Calls!A:I',
  };
}

function buildRow(reportData) {
  return [
    reportData.debtorName    || '',
    reportData.phone         || '',
    reportData.amountOwed    || '',
    reportData.daysOverdue   || '',
    reportData.callResult    || '',  // BML code: PROM, NOPA, NRED, etc.
    reportData.amountAgreed  || '',
    reportData.commitmentDate|| '',
    reportData.email         || '',
    reportData.notes         || '',
  ];
}

async function appendCallReport(reportData) {
  const { spreadsheetId, range } = getSheetsConfig();
  // Supports three credential formats:
  // 1. GOOGLE_SERVICE_ACCOUNT_B64: base64-encoded JSON (no escaping issues)
  // 2. GOOGLE_SERVICE_ACCOUNT_JSON: raw JSON string
  // 3. File fallback: ./google-credentials.json
  let credentialsJson;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_B64) {
    credentialsJson = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8');
    console.log('[Sheets] Loaded credentials from GOOGLE_SERVICE_ACCOUNT_B64');
  } else if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    credentialsJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    console.log('[Sheets] Loaded credentials from GOOGLE_SERVICE_ACCOUNT_JSON');
  } else {
    try {
      credentialsJson = fs.readFileSync('./google-credentials.json', 'utf8');
      console.log('[Sheets] Loaded credentials from file');
    } catch (e) {
      console.error('[Sheets] Could not read google-credentials.json:', e.message);
      throw new Error('No credentials found: set GOOGLE_SERVICE_ACCOUNT_B64, GOOGLE_SERVICE_ACCOUNT_JSON, or provide google-credentials.json');
    }
  }

  if (!credentialsJson || !spreadsheetId) {
    console.warn('[Sheets] Omitido: faltan GOOGLE_SERVICE_ACCOUNT_JSON o GOOGLE_SHEETS_SPREADSHEET_ID');
    return { skipped: true };
  }

  console.log('[Sheets] Iniciando append de reporte');
  console.log(`[Sheets] Target spreadsheetId=${spreadsheetId} range=${range}`);
  console.log('[Sheets] credentialsJson length:', credentialsJson?.length || 0);
  console.log('[Sheets] GOOGLE_SHEETS_SPREADSHEET_ID:', spreadsheetId);

  try {
    console.log('[Sheets] credentialsJson type:', typeof credentialsJson);
    console.log('[Sheets] credentialsJson length:', credentialsJson?.length);
    console.log('[Sheets] credentialsJson first 100 chars:', credentialsJson?.substring(0, 100));
    console.log('[Sheets] credentialsJson last 100 chars:', credentialsJson?.substring(credentialsJson.length - 100));

    const credentials = JSON.parse(credentialsJson);
    console.log('[Sheets] Credentials parsed OK');
    console.log('[Sheets] private_key starts with:', credentials.private_key?.substring(0, 50));

    if (credentials.private_key) {
      credentials.private_key = credentials.private_key
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .trim();
    }
    console.log('[Sheets] private_key fixed:', credentials.private_key.split('\n').length, 'lines');

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    console.log('[Sheets] GoogleAuth created');

    const sheets = google.sheets({ version: 'v4', auth });
    console.log('[Sheets] Sheets client initialized');

    const response = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [buildRow(reportData)] },
    });
    console.log('[Sheets] Append OK, response.updates:', response?.data?.updates);

    const updates = response.data?.updates || {};
    console.log(`[Sheets] Append OK | updatedRange=${updates.updatedRange || 'N/A'} | updatedRows=${updates.updatedRows || 0}`);
    return { ok: true, updates };
  } catch (err) {
    console.error('[Sheets] Append ERROR:', err.code || err.message);
    console.error('[Sheets] Full error:', JSON.stringify(err, null, 2));
    throw err;
  }
}

module.exports = { appendCallReport };
