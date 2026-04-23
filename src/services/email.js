'use strict';

const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

const SEMAPHORE_EMOJI = { verde: '🟢', amarillo: '🟡', rojo: '🔴' };

async function sendCallReport(report) {
  const {
    debtorName,
    callSid,
    duration,
    semaphore,
    result,
    summary,
    keyMoments,
    nextAction,
  } = report;

  const emoji = SEMAPHORE_EMOJI[semaphore] || '⚪';

  const html = `
  <h2>📞 Reporte de Llamada — Cole</h2>
  <p><b>Deudor:</b> ${debtorName}</p>
  <p><b>Resultado:</b> ${result}</p>
  <p><b>Resumen:</b> ${summary}</p>
  <p><b>Próxima acción:</b> ${nextAction}</p>
  <p><b>Call SID:</b> ${callSid}</p>
  <p><b>Duración:</b> ${duration || 'N/A'}</p>
  ${keyMoments?.length ? `<ul>${keyMoments.map(m => `<li>${m}</li>`).join('')}</ul>` : ''}
  `;

  await resend.emails.send({
    from: 'Cole Call Center <onboarding@resend.dev>',
    to: process.env.REPORT_EMAIL || 'salvadormuttini@gmail.com',
    subject: `${emoji} Llamada: ${debtorName} — ${result}`,
    html,
  });

  console.log(`[Email] Reporte enviado por Resend para ${debtorName}`);
}

module.exports = { sendCallReport };