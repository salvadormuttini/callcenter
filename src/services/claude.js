'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT } = require('../config/valentina');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Detecta fin de oración: . ! ? seguido de espacio (o fin de string)
const SENTENCE_END = /^(.*?[.!?])\s/;

function buildSystem(debtorInfo, customSystemPrompt = null) {
  // Si hay prompt custom, lo usa directamente (llamadas no-cobranzas)
  if (customSystemPrompt) {
    return [{ type: 'text', text: customSystemPrompt }];
  }

  const ctx = debtorInfo
    ? [
        '=== INFORMACIÓN DEL DEUDOR ===',
        `Nombre: ${debtorInfo.name || 'Desconocido'}`,
        `Cuenta: ${debtorInfo.accountId || 'N/A'}`,
        `Monto: $${(debtorInfo.amount || 0).toLocaleString('es-AR')}`,
        `Mora: ${debtorInfo.daysOverdue || 0} días`,
      ].join('\n')
    : 'Sin datos del deudor.';

  return [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: ctx },
  ];
}

/**
 * Streaming frase por frase: llama onSentence() en cuanto cada oración está completa.
 * Devuelve el texto completo al terminar.
 * Latencia al primer onSentence(): ~200-400ms con Haiku.
 */
async function streamBySentence(history, debtorInfo, onSentence, customSystemPrompt = null) {
  const stream = client.messages.stream({
    model: 'claude-haiku-4-5',
    max_tokens: 80,
    system: buildSystem(debtorInfo, customSystemPrompt),
    messages: history,
  });

  let buffer = '';
  let fullText = '';

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      buffer += event.delta.text;

      let match;
      while ((match = SENTENCE_END.exec(buffer)) !== null) {
        const sentence = match[1].trim();
        if (sentence) {
          fullText += (fullText ? ' ' : '') + sentence;
          await onSentence(sentence);
        }
        buffer = buffer.slice(match[0].length);
      }
    }
  }

  // Flush del fragmento final (sin puntuación)
  const tail = buffer.trim();
  if (tail) {
    fullText += (fullText ? ' ' : '') + tail;
    await onSentence(tail);
  }

  return fullText || '¿Me podés repetir eso?';
}

// Compatibilidad con el saludo (no necesita streaming frase por frase)
async function getResponse(history, debtorInfo) {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    temperature: 0.7,
    max_tokens: 80,
    system: buildSystem(debtorInfo),
    messages: history,
  });
  const block = response.content.find((b) => b.type === 'text');
  return block ? block.text.trim() : '¿Me podés repetir eso?';
}

module.exports = { streamBySentence, getResponse };
