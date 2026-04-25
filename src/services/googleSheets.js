'use strict';

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
    new Date().toISOString(),
    reportData.debtorName || 'Desconocido',
    reportData.callSid || '',
    reportData.semaphore || '',
    reportData.categorizacion || '',
    reportData.result || '',
    reportData.summary || '',
    (reportData.keyMoments || []).join(' | '),
    reportData.nextAction || '',
  ];
}

async function appendCallReport(reportData) {
  const { credentialsJson, spreadsheetId, range } = getSheetsConfig();

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

    console.log('[Sheets] private_key newline check:', {
      hasBackslashN: credentials.private_key.includes('\\n'),
      hasRealNewline: credentials.private_key.includes('\n'),
      firstLine: credentials.private_key.split('\n')[0],
    });

    if (credentials.private_key.includes('\\n')) {
      credentials.private_key = credentials.private_key.split('\\n').join('\n');
    } else if (!credentials.private_key.includes('\n')) {
      console.log('[Sheets] private_key already has real newlines');
    }
    console.log('[Sheets] private_key normalized');

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
