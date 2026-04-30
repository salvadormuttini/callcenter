# Cole — Test Plan

## Objetivo
Comparar Cole vs bot actual en 20–30 deudores reales.
Medir: RPC, PTP, monto, calidad, errores.

## CSV esperado
Columnas: nombre, telefono, monto, dias_mora
Ejemplo:
Juan García,+5491112345678,50000,30
María López,+5491123456789,75000,45

## Checklist antes de campaña
- [ ] PANEL_PASSWORD está seteado en Railway
- [ ] Disclaimer legal funciona (escúchalo)
- [ ] Control horarios 10-17 funcionando
- [ ] Google Sheets actualiza después de cada llamada
- [ ] Emails de alerta llegan
- [ ] Retry queue funciona
- [ ] Panel sube CSV sin errores
- [ ] Botón "Iniciar campaña" anda
- [ ] Botón "Detener campaña" anda
- [ ] Logs se escriben (/api/logs accessible)

## KPIs a medir
- RPC (Right Party Contact): % que atienden
- PTP (Promise to Pay): % que prometen pagar
- Monto promedio acordado
- Tasa de error técnico
- Duración promedio por llamada
- Calidad conversacional (1-10 subjetivo)

## Comparación vs bot actual
Mismos deudores, mismo día/horario
Spreadsheet lado a lado:
Deudor | Cole RPC | Bot RPC | Cole PTP | Bot PTP | Cole Monto | Bot Monto

## Si falla una llamada
1. Revisar /api/logs para error específico
2. Si es error técnico (Twilio, ElevenLabs, Deepgram):
   - Sistema reintenta en 2 horas
   - Vos también podés hacer click en fila para reintentar manual
3. Si es sin contacto (no atiende):
   - Automático en retry queue
   - Máximo 3 intentos

## Criterios de éxito
- [ ] 0 crashes durante campaña
- [ ] RPC >= 70%
- [ ] PTP >= 20% (umbral mínimo viable)
- [ ] 0 problemas de disclaimer/horarios
- [ ] Google Sheets actualiza correctamente
- [ ] Cole >= o mejor que bot actual en 2+ KPIs
