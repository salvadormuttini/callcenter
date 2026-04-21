'use strict';

const twilio = require('twilio');

function getClient() {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

const SEMAPHORE_EMOJI = { verde: '🟢', amarillo: '🟡', rojo: '🔴' };

/**
 * Envía el reporte de llamada por WhatsApp.
 * Usa el sandbox de Twilio en desarrollo, número aprobado en producción.
 */
async function sendWhatsAppReport(report) {
  const {
    debtorName,
    callSid,
    semaphore,
    result,
    summary,
    keyMoments,
    nextAction,
  } = report;

  const emoji = SEMAPHORE_EMOJI[semaphore] || '⚪';

  const lines = [
    `${emoji} *Reporte de llamada — Cole*`,
    ``,
    `👤 *Deudor:* ${debtorName}`,
    `📋 *Resultado:* ${result}`,
    ``,
    `📝 *Resumen:*`,
    summary,
    ``,
  ];

  if (keyMoments?.length) {
    lines.push(`🔑 *Momentos clave:*`);
    keyMoments.forEach(m => lines.push(`  • ${m}`));
    lines.push('');
  }

  lines.push(`➡️ *Próxima acción:* ${nextAction}`);
  lines.push(``);
  lines.push(`_Call SID: ${callSid}_`);

  const body = lines.join('\n');

  const from = process.env.WHATSAPP_FROM || 'whatsapp:+14155238886'; // sandbox por defecto
  const to = `whatsapp:${process.env.WHATSAPP_TO || '+5491131427982'}`;

  await getClient().messages.create({ from, to, body });

  console.log(`[WhatsApp] Reporte enviado a ${to}`);
}

module.exports = { sendWhatsAppReport };
