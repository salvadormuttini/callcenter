'use strict';

const { google } = require('googleapis');


function buildSheetsClient() {
  const credentialsJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!credentialsJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set');

  const credentials = JSON.parse(credentialsJson);
  credentials.private_key = credentials.private_key
    .replace(/\\n/g, '\n')
    .replace(/\n/g, '\n');
  console.log('[Sheets DEBUG] private_key starts with:', credentials.private_key.slice(0, 30));
  console.log('[Sheets DEBUG] has END:', credentials.private_key.includes('-----END PRIVATE KEY-----'));
  console.log('[Sheets DEBUG] key length:', credentials.private_key.length);
  console.log('[Sheets DEBUG] newline count:', (credentials.private_key.match(/\n/g) || []).length);
  console.log('[Sheets DEBUG] key ends with:', credentials.private_key.slice(-30));

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
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

// ─── Queue persistence ────────────────────────────────────────────────────────

const QUEUE_TAB     = 'Queue';
const QUEUE_HEADERS = ['id','name','phone','amount','daysOverdue','status','callSid','error','createdAt','updatedAt'];

async function ensureQueueTab(sheets, spreadsheetId) {
  const meta   = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets.some(s => s.properties.title === QUEUE_TAB);
  if (exists) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: QUEUE_TAB } } }] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range:            `${QUEUE_TAB}!A1:J1`,
    valueInputOption: 'RAW',
    requestBody:      { values: [QUEUE_HEADERS] },
  });
}

// Appends a new queue item row. Returns the 1-based sheet row number.
async function saveQueueItem(item) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) return null;

  const sheets = buildSheetsClient();
  await ensureQueueTab(sheets, spreadsheetId);

  const now = new Date().toISOString();
  const row = [
    item.id,
    item.debtorInfo?.name        || '',
    item.phone                   || '',
    item.debtorInfo?.amount      || '',
    item.debtorInfo?.daysOverdue || '',
    item.status,
    item.callSid  || '',
    item.error    || '',
    now, now,
  ];

  const res = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range:            `${QUEUE_TAB}!A:J`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody:      { values: [row] },
  });

  const match = res.data?.updates?.updatedRange?.match(/!A(\d+)/);
  return match ? parseInt(match[1]) : null;
}

// Updates status/callSid/error/updatedAt for a row we already know the number of.
async function updateQueueRow(sheetRow, status, callSid, error) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId || !sheetRow) return;

  const sheets = buildSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range:            `${QUEUE_TAB}!F${sheetRow}:J${sheetRow}`,
    valueInputOption: 'RAW',
    requestBody:      { values: [[status, callSid || '', error || '', '', new Date().toISOString()]] },
  });
}

// Returns all rows whose status is 'pending', with _sheetsRow set.
async function loadPendingQueue() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) return [];

  const sheets = buildSheetsClient();
  await ensureQueueTab(sheets, spreadsheetId);

  const res  = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${QUEUE_TAB}!A:J` });
  const rows = res.data.values || [];
  if (rows.length < 2) return [];

  const pending = [];
  for (let i = 1; i < rows.length; i++) {
    const [id, name, phone, amount, daysOverdue, status, callSid, error, createdAt] = rows[i];
    if (status !== 'pending') continue;
    pending.push({
      id,
      phone,
      debtorInfo: { name, phone, amount: Number(amount) || 0, daysOverdue: Number(daysOverdue) || 0 },
      status:    'pending',
      callSid:   callSid  || null,
      error:     error    || null,
      addedAt:   createdAt ? new Date(createdAt).getTime() : Date.now(),
      _sheetsRow: i + 1, // 1-based (row 1 = headers)
    });
  }
  return pending;
}

// Marks all pending rows as 'cancelled' (called before starting a new campaign).
async function cancelAllPendingQueueItems() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) return;

  const sheets = buildSheetsClient();
  const res    = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${QUEUE_TAB}!A:F` });
  const rows   = res.data.values || [];
  const now    = new Date().toISOString();

  const updates = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]?.[5] === 'pending') {
      updates.push({
        range:  `${QUEUE_TAB}!F${i + 1}:J${i + 1}`,
        values: [['cancelled', '', 'Nueva campaña', '', now]],
      });
    }
  }
  if (updates.length === 0) return;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data: updates },
  });
}

// ─── Dashboard tab ────────────────────────────────────────────────────────────

const DASHBOARD_TAB = 'Dashboard';

const DASHBOARD_LABELS = [
  'Total llamadas',
  'PTP (prometió pagar)',
  'Tasa PTP %',
  'Monto recuperado',
  'Promedio por llamada',
];

const DASHBOARD_FORMULAS = [
  "=COUNTA(FILTER('Hoja 1'!E:E,'Hoja 1'!E:E<>\"\"))",
  "=COUNTIF(FILTER('Hoja 1'!E:E,'Hoja 1'!E:E<>\"\"),\"PROM\")",
  '=IF(A1=0,0,ROUND(A2/A1*100,1))',
  "=SUMIF(FILTER('Hoja 1'!F:F,'Hoja 1'!F:F<>\"\"),\">0\")",
  '=IF(A1=0,0,ROUND(A4/A1,0))',
];

async function ensureDashboardTab(sheets, spreadsheetId) {
  const meta   = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets.some(s => s.properties.title === DASHBOARD_TAB);
  if (exists) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: DASHBOARD_TAB } } }] },
  });

  // Write formulas in A1:A5 and labels in B1:B5
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: [
        { range: `${DASHBOARD_TAB}!A1:A5`, values: DASHBOARD_FORMULAS.map(f => [f]) },
        { range: `${DASHBOARD_TAB}!B1:B5`, values: DASHBOARD_LABELS.map(l => [l]) },
      ],
    },
  });
}

async function readDashboard() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) return { total: 0, ptp: 0, rate: 0, amount: 0, average: 0 };

  const sheets = buildSheetsClient();
  await ensureDashboardTab(sheets, spreadsheetId);

  const res  = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${DASHBOARD_TAB}!A1:A5` });
  const vals = res.data.values || [];

  const n = (i) => Number((vals[i] || [])[0]) || 0;
  return {
    total:   n(0),
    ptp:     n(1),
    rate:    n(2),
    amount:  n(3),
    average: n(4),
  };
}

module.exports = { appendCallReport, getSheetRows, saveQueueItem, updateQueueRow, loadPendingQueue, cancelAllPendingQueueItems, readDashboard };
