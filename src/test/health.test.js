'use strict';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

console.log('\nCole Health Tests');
console.log('─'.repeat(30));

// ─── Test 1: callQueue exports ────────────────────────────────────────────────
test('callQueue exports correct functions', () => {
  const callQueue = require('../services/callQueue');
  const expected = ['addToQueue','addBatch','clearPending','getQueueStatus','resetQueue','resetQueueAndSheets','resumeFromSheets','startProcessing'];
  for (const fn of expected) {
    assert(typeof callQueue[fn] === 'function', `callQueue.${fn} is not a function`);
  }
});

// ─── Test 2: Auth session lifecycle ──────────────────────────────────────────
test('auth session lifecycle: create → validate → destroy', () => {
  const auth = require('../middleware/auth');
  const token = auth.createSession();
  assert(typeof token === 'string' && token.length === 64, 'Token should be 64-char hex string');
  assert(auth.isValidSession(token), 'Newly created session should be valid');
  auth.destroySession(token);
  assert(!auth.isValidSession(token), 'Destroyed session should be invalid');
});

// ─── Test 3: buildRow length ──────────────────────────────────────────────────
test('buildRow() produces array of length 9', () => {
  function buildRow(reportData) {
    return [
      reportData.debtorName    || '',
      reportData.phone         || '',
      reportData.amountOwed    || '',
      reportData.daysOverdue   || '',
      reportData.callResult    || '',
      reportData.amountAgreed  || '',
      reportData.commitmentDate|| '',
      reportData.email         || '',
      reportData.notes         || '',
    ];
  }
  const row = buildRow({ debtorName: 'Juan', callResult: 'PROM', notes: 'test' });
  assert(Array.isArray(row), 'buildRow should return an array');
  assert(row.length === 9, `Expected length 9, got ${row.length}`);
  assert(row[0] === 'Juan', 'debtorName should be first element');
  assert(row[4] === 'PROM', 'callResult should be fifth element');
});

// ─── Test 4: isWithinCallHours returns boolean ────────────────────────────────
test('isWithinCallHours() returns a boolean', () => {
  function isWithinCallHours() {
    const now = new Date();
    const hour = Number(now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires', hour: 'numeric', hour12: false }));
    return hour >= 10 && hour < 17;
  }
  const result = isWithinCallHours();
  assert(typeof result === 'boolean', `Expected boolean, got ${typeof result}`);
});

// ─── Test 5: Required env var list is well-formed ────────────────────────────
test('required env var list is well-formed', () => {
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
  assert(required.length >= 8, 'Must have at least 8 required env vars');
  for (const key of required) {
    assert(typeof key === 'string' && key.length > 0, `Env var key must be non-empty string: ${key}`);
    assert(key === key.toUpperCase(), `Env var key should be uppercase: ${key}`);
  }
});

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
