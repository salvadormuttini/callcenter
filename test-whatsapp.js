'use strict';

require('dotenv').config();
const { sendWhatsAppReport } = require('./src/services/whatsapp');

async function main() {
  console.log('─── Diagnóstico WhatsApp ────────────────────────────────────');
  console.log(`WHATSAPP_FROM: ${process.env.WHATSAPP_FROM || '❌ VACÍO'}`);
  console.log(`WHATSAPP_TO:   ${process.env.WHATSAPP_TO || '❌ VACÍO'}`);
  console.log('─────────────────────────────────────────────────────────────\n');

  console.log('📲 Enviando mensaje de prueba...');

  await sendWhatsAppReport({
    debtorName: 'Salvador Muttini (TEST)',
    callSid: 'CA_TEST_123',
    semaphore: 'verde',
    result: 'Acordó pago total de $75.000 para el viernes',
    summary: 'El deudor reconoció la deuda y se mostró colaborativo. Acordó transferir el monto completo antes del viernes. Tono amigable durante toda la llamada.',
    keyMoments: [
      'Reconoció la deuda sin resistencia',
      'Propuso fecha concreta de pago',
      'Pidió datos bancarios para transferencia',
    ],
    nextAction: 'Confirmar recepción de pago el viernes por la tarde',
  });

  console.log('✅ Mensaje enviado. Revisá WhatsApp en +5491131427982');
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  if (err.code === 63007 || err.message.includes('not a valid')) {
    console.error('\n💡 El número destinatario no está en el sandbox.');
    console.error('   Desde +5491131427982, enviá por WhatsApp al +1 415 523 8886:');
    console.error('   "join <keyword-del-sandbox>"');
    console.error('   El keyword lo encontrás en: console.twilio.com → Messaging → Try it out → Send a WhatsApp message');
  }
  if (err.message.includes('not a WhatsApp')) {
    console.error('\n💡 WHATSAPP_FROM no es un número habilitado para WhatsApp.');
    console.error('   Usá el sandbox: whatsapp:+14155238886');
  }
});
