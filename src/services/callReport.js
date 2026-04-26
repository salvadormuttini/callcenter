'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { sendCallReport } = require('./email');
const { sendWhatsAppReport } = require('./whatsapp');
const { appendCallReport } = require('./googleSheets');
const { appendAnalytics } = require('./analyticsSheet');
const { BML_CODES } = require('../config/bml-codes');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Analiza la conversación con Claude y envía el reporte por email.
 * Se llama al finalizar cada llamada con turnos de conversación.
 */
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

 console.log('[Report] pidiendo análisis a Claude');
const response = await client.messages.create({
  model: 'claude-haiku-4-5',
  max_tokens: 512,
  messages: [{ role: 'user', content: prompt }],
});
console.log('[Report] Claude respondió');

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
  };

  // Email y WhatsApp en paralelo
console.log('[Report] entrando a envío');  
const [emailResult, whatsappResult, sheetsResult, analyticsResult] = await Promise.allSettled([
    sendCallReport(reportData),
    sendWhatsAppReport(reportData),
    appendCallReport(reportData),
    appendAnalytics(reportData),
  ]);
console.log('[Report] EMAIL:', emailResult.status, emailResult.reason?.message || 'OK');
console.log('[Report] WHATSAPP:', whatsappResult.status, whatsappResult.reason?.message || 'OK');
console.log('[Report] SHEETS:', sheetsResult.status, sheetsResult.reason?.message || 'OK');
console.log('[Report] ANALYTICS:', analyticsResult.status, analyticsResult.reason?.message || 'OK');
}

module.exports = { generateAndSendReport };
