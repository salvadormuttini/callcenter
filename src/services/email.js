'use strict';

const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
family: 4,
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
      connectionTimeout: 10000,
      socketTimeout: 15000,
    });
  }
  return transporter;
}

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
  const semaphoreLabel = {
    verde: 'ALTA probabilidad de cobro',
    amarillo: 'PROBABILIDAD MEDIA',
    rojo: 'BAJA probabilidad de cobro',
  }[semaphore] || 'Sin datos';

  const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><style>
  body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333; }
  .header { background: #1a1a2e; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
  .semaphore { font-size: 48px; text-align: center; padding: 20px; }
  .section { padding: 16px 20px; border-bottom: 1px solid #eee; }
  .label { font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 1px; }
  .value { font-size: 16px; margin-top: 4px; }
  .verde { background: #e8f5e9; border-left: 4px solid #4caf50; }
  .amarillo { background: #fffde7; border-left: 4px solid #ffeb3b; }
  .rojo { background: #ffebee; border-left: 4px solid #f44336; }
  ul { margin: 8px 0; padding-left: 20px; }
  li { margin: 4px 0; }
  .footer { font-size: 12px; color: #aaa; text-align: center; padding: 16px; }
</style></head>
<body>
  <div class="header">
    <h2 style="margin:0">📞 Reporte de Llamada — Cole</h2>
    <p style="margin:4px 0;opacity:0.7">${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}</p>
  </div>

  <div class="semaphore ${semaphore}">${emoji}<br>
    <span style="font-size:18px;font-weight:bold">${semaphoreLabel}</span>
  </div>

  <div class="section">
    <div class="label">Deudor</div>
    <div class="value" style="font-size:20px;font-weight:bold">${debtorName}</div>
  </div>

  <div class="section">
    <div class="label">Resultado</div>
    <div class="value">${result}</div>
  </div>

  <div class="section">
    <div class="label">Resumen de la conversación</div>
    <div class="value">${summary}</div>
  </div>

  ${keyMoments?.length ? `
  <div class="section">
    <div class="label">Momentos clave</div>
    <ul>${keyMoments.map(m => `<li>${m}</li>`).join('')}</ul>
  </div>` : ''}

  <div class="section">
    <div class="label">Próxima acción recomendada</div>
    <div class="value" style="font-weight:bold">→ ${nextAction}</div>
  </div>

  <div class="section" style="background:#f9f9f9">
    <div class="label">Datos técnicos</div>
    <div class="value" style="font-size:13px;color:#666">
      Call SID: ${callSid}<br>
      Duración: ${duration || 'N/A'}
    </div>
  </div>

  <div class="footer">Generado por Cole Call Center · ${process.env.COMPANY_NAME || 'Financiera Sur'}</div>
</body>
</html>`;

  await getTransporter().sendMail({
    from: `"Cole Call Center" <${process.env.GMAIL_USER}>`,
    to: process.env.REPORT_EMAIL || 'salvadormuttini@gmail.com',
    subject: `${emoji} Llamada: ${debtorName} — ${result}`,
    html,
  });

  console.log(`[Email] Reporte enviado para ${debtorName} (${semaphore})`);
}

module.exports = { sendCallReport };