'use strict';

const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

/**
 * Builds a Google Sheets client using GOOGLE_APPLICATION_CREDENTIALS
 * (set automatically by scripts/setup-credentials.js at startup).
 * No manual JSON parsing or private_key escaping needed.
 */
function buildSheetsClient() {
  const auth = new google.auth.GoogleAuth({ scopes: SCOPES });
  return google.sheets({ version: 'v4', auth });
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
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const range         = process.env.GOOGLE_SHEETS_RANGE || 'A:I';

  if (!spreadsheetId) {
    console.warn('[Sheets] Omitido: falta GOOGLE_SHEETS_SPREADSHEET_ID');
    return { skipped: true };
  }

  console.log(`[Sheets] append → spreadsheetId=${spreadsheetId} range=${range}`);

  const sheets = buildSheetsClient();
  const response = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [buildRow(reportData)] },
  });

  const updates = response.data?.updates || {};
  console.log(`[Sheets] OK | updatedRange=${updates.updatedRange} | rows=${updates.updatedRows}`);
  return { ok: true, updates };
}

async function getSheetRows(spreadsheetId, range) {
  const sheets = buildSheetsClient();
  const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return response.data.values || [];
}

module.exports = { appendCallReport, getSheetRows };
