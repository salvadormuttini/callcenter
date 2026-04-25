'use strict';

/**
 * Startup script: decodes GOOGLE_SERVICE_ACCOUNT_B64 to a temp file
 * and sets GOOGLE_APPLICATION_CREDENTIALS so googleapis picks it up automatically.
 * Run before server.js.
 */

const fs   = require('fs');
const path = require('path');

const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;

if (b64) {
  const json = Buffer.from(b64, 'base64').toString('utf8');
  const dest = '/tmp/google-service-account.json';
  fs.writeFileSync(dest, json, 'utf8');
  process.env.GOOGLE_APPLICATION_CREDENTIALS = dest;
  console.log('[Setup] Google credentials written to', dest);
} else {
  console.warn('[Setup] GOOGLE_SERVICE_ACCOUNT_B64 not set — skipping credentials setup');
}
