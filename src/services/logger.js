'use strict';

const fs   = require('fs');
const path = require('path');

const LOG_FILE = process.env.LOG_FILE || '/tmp/cole.log';
const MAX_LINES_API = 50;

function timestamp() {
  return new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
}

function write(level, tag, message, extra) {
  const line = `[${timestamp()}] [${level}] [${tag}] ${message}${extra ? ' | ' + JSON.stringify(extra) : ''}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {
    // Non-fatal: log file write failure shouldn't crash the app
    console.error('[Logger] No se pudo escribir en', LOG_FILE, e.message);
  }
}

const log = {
  info:  (tag, msg, extra) => write('INFO ', tag, msg, extra),
  error: (tag, msg, extra) => write('ERROR', tag, msg, extra),
  warn:  (tag, msg, extra) => write('WARN ', tag, msg, extra),

  call(phone, debtorName, action, extra) {
    write('INFO ', 'CALL', `${action} | ${debtorName} | ${phone}`, extra);
  },

  retry(phone, attempts, action) {
    write('INFO ', 'RETRY', `${action} | ${phone} | attempts=${attempts}`);
  },
};

function readLastLines(n = MAX_LINES_API) {
  try {
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines   = content.split('\n').filter(Boolean);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

module.exports = { log, readLastLines };
