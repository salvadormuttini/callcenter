'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { sendCallReport } = require('./email');
const { sendWhatsAppReport } = require('./whatsapp');

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
  "result": "Una oración concisa del resultado (ej: 'Acordó pago parcial de $30.000 para el viernes')",
  "summary": "2-3 oraciones resumiendo qué pasó en la llamada",
  "keyMoments": ["momento 1", "momento 2", "momento 3"],
  "nextAction": "Qué hacer a continuación (ej: 'Llamar el viernes para confirmar el pago')"
}

Criterio del semáforo:
- verde: comprometió pago, dio fecha concreta, actitud colaborativa
- amarillo: interesado pero sin compromiso firme, pidió tiempo, excusas vagas
- rojo: negó la deuda, se puso agresivo, no tiene intención de pagar, llamada muy corta

Deudor: ${debtorName}
Monto: $${amount?.toLocaleString('es-AR') || 'N/A'}
Estado final: ${callStatus}

Conversación:
${turns}

Respondé SOLO con el JSON, sin texto adicional.`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

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
      result: 'No se pudo analizar la llamada',
      summary: turns.slice(0, 200),
      keyMoments: [],
      nextAction: 'Revisar la transcripción manualmente',
    };
  }

  const reportData = {
    debtorName,
    callSid,
    semaphore: analysis.semaphore,
    result: analysis.result,
    summary: analysis.summary,
    keyMoments: analysis.keyMoments || [],
    nextAction: analysis.nextAction,
  };

  // Email y WhatsApp en paralelo
  await Promise.allSettled([
    sendCallReport(reportData),
    sendWhatsAppReport(reportData),
  ]);
}

module.exports = { generateAndSendReport };
