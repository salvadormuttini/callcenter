'use strict';

require('dotenv').config();
const nodemailer = require('nodemailer');

async function main() {
  const { GMAIL_USER, GMAIL_APP_PASSWORD, REPORT_EMAIL } = process.env;

  console.log('─── Diagnóstico de configuración ───────────────────────────');
  console.log(`GMAIL_USER:         ${GMAIL_USER || '❌ VACÍO'}`);
  console.log(`GMAIL_APP_PASSWORD: ${GMAIL_APP_PASSWORD ? '✅ configurado (' + GMAIL_APP_PASSWORD.length + ' chars)' : '❌ VACÍO'}`);
  console.log(`REPORT_EMAIL:       ${REPORT_EMAIL || '❌ VACÍO'}`);
  console.log('────────────────────────────────────────────────────────────');

  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    console.error('\n❌ Faltan credenciales. Completá GMAIL_APP_PASSWORD en el .env\n');
    console.log('Cómo obtener el App Password:');
    console.log('1. myaccount.google.com/security');
    console.log('2. Verificación en 2 pasos → Contraseñas de aplicaciones');
    console.log('3. Crear nueva → nombre: Cole → copiar las 16 letras');
    process.exit(1);
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });

  console.log('\n🔌 Verificando conexión con Gmail...');
  await transporter.verify();
  console.log('✅ Conexión OK\n');

  console.log('📧 Enviando email de prueba...');
  const info = await transporter.sendMail({
    from: `"Cole Call Center" <${GMAIL_USER}>`,
    to: REPORT_EMAIL,
    subject: '✅ Test — Cole Call Center funciona',
    html: `
      <h2>✅ Nodemailer configurado correctamente</h2>
      <p>Si recibiste este email, los reportes de llamadas van a llegar sin problemas.</p>
      <hr>
      <p style="color:#888;font-size:12px">Enviado desde Cole Call Center · ${new Date().toLocaleString('es-AR')}</p>
    `,
  });

  console.log(`✅ Email enviado. Message ID: ${info.messageId}`);
  console.log(`📬 Revisá tu bandeja en: ${REPORT_EMAIL}`);
}

main().catch(err => {
  console.error('\n❌ Error:', err.message);
  if (err.message.includes('Invalid login') || err.message.includes('Username and Password')) {
    console.error('\n💡 El App Password es incorrecto o usaste la contraseña normal de Gmail.');
    console.error('   Generá un App Password específico en myaccount.google.com/apppasswords');
  }
  if (err.message.includes('Less secure')) {
    console.error('\n💡 Gmail bloqueó el acceso. Usá un App Password en vez de tu contraseña normal.');
  }
});
