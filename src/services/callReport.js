'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { sendCallReport } = require('./email');
const { sendWhatsAppReport } = require('./whatsapp');
const { appendCallReport } = require('./googleSheets');
const { appendAnalytics } = require('./analyticsSheet');
const { BML_CODES } = require('../config/bml-codes');
const { addToRetry, RETRY_CODES } = require('./retryQueue');
const { log } = require('./logger');
const { Resend } = require('resend');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const resend  = new Resend(process.env.RESEND_API_KEY);

async function sendErrorAlert(debtorName, callSid, err) {
  try {
    await resend.emails.send({
      from:    'Cole Call Center <onboarding@resend.dev>',
      to:      'salvadormuttini@gmail.com',
      subject: `⚠️ Cole — Error en llamada a ${debtorName}`,
      html: `
        <h2>⚠️ Error en reporte de llamada</h2>
        <p><b>Deudor:</b> ${debtorName}</p>
        <p><b>CallSid:</b> ${callSid}</p>
        <p><b>Timestamp:</b> ${new Date().toISOString()}</p>
        <p><b>Error:</b> ${err?.message || String(err)}</p>
        <pre style="background:#f5f5f5;padding:12px;border-radius:6px">${err?.stack || ''}</pre>
      `,
    });
  } catch (alertErr) {
    log.error('Report', 'No se pudo enviar alerta de error', { alertErr: alertErr.message });
  }
}

async function generateAndSendReport(session, callSid, callStatus) {
  if (!session || session.history.length < 2) return;

  const debtorName = session.debtorInfo?.name || 'Desconocido';
  const amount = session.debtorInfo?.amount;
  const turns = session.history
    .map(m => `${m.role === 'user' ? 'Deudor' : 'Cole'}: ${m.content}`)
    .join('\n');

  const prompt = `Analizá esta conversación de cobranzas y devolvé un JSON con exactamente estos campos:

{
  "semaphore": "verde" | "amarillo" | "rojo",
  "categorizacion": "<código BML>",
  "ptp": "sí" | "no",
  "amountAgreed": "<monto acordado como string, ej: '50000', o vacío si no hubo acuerdo>",
  "commitmentDate": "<fecha de pago acordada como string, ej: 'viernes 30/04', o vacío si no hubo>",
  "mainObjection": "<objeción principal del deudor, ej: 'no tiene dinero esta semana', o vacío>",
  "whyNotPaid": "<razón de fondo por la que no pagó, ej: 'liquidez', 'evasión', 'disputa', 'desconocía', o vacío si pagó>",
  "keyMoment": "<el momento más importante de la conversación en 1 oración>",
  "recommendation": "<qué hacer distinto en la próxima llamada, 1 oración>",
  "sentiment": "positivo" | "neutral" | "negativo",
  "callQuality": <número 1-10 basado en fluidez, claridad y persuasión de la llamada>,
  "recoveryScore": <número 1-10 basado en probabilidad real de que el deudor pague>,
  "result": "Una oración concisa del resultado (ej: 'Acordó pago parcial de $30.000 para el viernes')",
  "summary": "2-3 oraciones resumiendo qué pasó en la llamada",
  "keyMoments": ["momento 1", "momento 2", "momento 3"],
  "nextAction": "Qué hacer a continuación (ej: 'Llamar el viernes para confirmar el pago')"
}

Criterio del semáforo:
- verde: comprometió pago, dio fecha concreta, actitud colaborativa
- amarillo: interesado pero sin compromiso firme, pidió tiempo, excusas vagas
- rojo: negó la deuda, se puso agresivo, no tiene intención de pagar, llamada muy corta

Códigos de categorización BML (elegí UNO según el resultado):
${BML_CODES}

Deudor: ${debtorName}
Monto: $${amount?.toLocaleString('es-AR') || 'N/A'}
Estado final: ${callStatus}

Conversación:
${turns}

Respondé SOLO con el JSON, sin texto adicional.`;

  let response;
  try {
    log.call(session.debtorInfo?.phone, debtorName, 'report-start', { callSid, callStatus });
    response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    });
    log.info('Report', 'Claude respondió', { callSid });
  } catch (err) {
    log.error('Report', 'Error al llamar a Claude', { callSid, error: err.message });
    await sendErrorAlert(debtorName, callSid, err);
    throw err;
  }

  const raw = response.content.find(b => b.type === 'text')?.text || '{}';

  let analysis;
  try {
    // Extraer JSON aunque venga con texto alrededor
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    analysis = JSON.parse(jsonMatch?.[0] || raw);
  } catch {
    console.error('[Report] No se pudo parsear el análisis:', raw);
    analysis = {
      semaphore: 'amarillo',
      categorizacion: 'VOLTA',
      result: 'No se pudo analizar la llamada',
      summary: turns.slice(0, 200),
      keyMoments: [],
      nextAction: 'Revisar la transcripción manualmente',
    };
  }

console.log('[Report] armando reportData');  
const reportData = {
    // identidad
    debtorName,
    callSid,
    phone:          session.debtorInfo?.phone        || '',
    email:          session.debtorInfo?.email        || '',
    // deuda
    amountOwed:     session.debtorInfo?.amount       || '',
    daysOverdue:    session.debtorInfo?.daysOverdue  || '',
    // resultado
    semaphore:      analysis.semaphore,
    callResult:     analysis.categorizacion          || 'VOLTA',  // BML code
    amountAgreed:   analysis.amountAgreed            || '',
    commitmentDate: analysis.commitmentDate          || '',
    notes:          analysis.nextAction              || '',
    // para email/WhatsApp (sin cambios)
    categorizacion: analysis.categorizacion          || 'VOLTA',
    result:         analysis.result,
    summary:        analysis.summary,
    keyMoments:     analysis.keyMoments              || [],
    nextAction:     analysis.nextAction,
    // analytics
    ptp:            analysis.ptp                    || 'no',
    mainObjection:  analysis.mainObjection           || '',
    whyNotPaid:     analysis.whyNotPaid              || '',
    keyMoment:      analysis.keyMoment               || '',
    recommendation: analysis.recommendation          || '',
    sentiment:      analysis.sentiment               || 'neutral',
    callQuality:    Number.isFinite(analysis.callQuality)    ? analysis.callQuality    : '',
    recoveryScore:  Number.isFinite(analysis.recoveryScore)  ? analysis.recoveryScore  : '',
  };

  // Email y WhatsApp en paralelo
console.log('[Report] entrando a envío');  
const [emailResult, whatsappResult, sheetsResult, analyticsResult] = await Promise.allSettled([
    sendCallReport(reportData),
    sendWhatsAppReport(reportData),
    appendCallReport(reportData),
    appendAnalytics(reportData),
  ]);
  log.info('Report', `EMAIL:${emailResult.status} WA:${whatsappResult.status} SHEETS:${sheetsResult.status} ANALYTICS:${analyticsResult.status}`, { callSid });

  if (emailResult.status === 'rejected')
    log.error('Report', 'Email falló', { callSid, error: emailResult.reason?.message });
  if (sheetsResult.status === 'rejected')
    log.error('Report', 'Sheets falló', { callSid, error: sheetsResult.reason?.message });
  if (analyticsResult.status === 'rejected')
    log.error('Report', 'Analytics falló', { callSid, error: analyticsResult.reason?.message });

  // Retry scheduling for no-contact BML codes
  const bml = analysis.categorizacion?.toUpperCase();
  if (RETRY_CODES.has(bml)) {
    const phone      = session.debtorInfo?.phone;
    const pastAttempts = session.debtorInfo?._retryAttempt || 0;
    if (phone) {
      addToRetry(phone, session.debtorInfo, pastAttempts);
      log.retry(phone, pastAttempts + 1, 'agendado');
    }
  }

  log.call(session.debtorInfo?.phone, debtorName, 'report-done', { callSid, bml });
}

module.exports = { generateAndSendReport };
