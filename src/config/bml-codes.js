'use strict';

const BML_CODES = `CLIENTE CONTACTADO:
- AGEN: Llamado agendado
- BAJA: El cliente solicitó la baja en ADT
- FALL: Falleció
- MUDO: Se mudó de ese domicilio
- NOPA: No va a pagar / No tiene reclamo fundado
- NOPU: Quiere pagar, pero por el momento no puede
- NOTI: Se notifica a tercero
- NOTR: Se notifica a TT o Responsable de pago
- NRED: No reconoce deuda
- PATA: Pago con Tarjeta de Crédito
- PPRO: El cliente afirma que pagó
- PROQ: Pago con Quita (Directv o Personal, solo Fase 3)
- PROM: Promesa de pago
- RECL: Reclamo realizado con documentación o número de reclamo
CLIENTE NO CONTACTADO:
- APAG: Teléfono apagado o fuera de cobertura
- CORT: Atendieron y cortaron (predictivo)
- INHA: Teléfono inhabilitado
- ERRN: Error de número
- MENS: Mensaje contestador
- NADA: No contesta
- NONO: Teléfono bueno pero no se puede dejar mensaje
- OCUP: Ocupado
- VOLTA: Volver a llamar`;

module.exports = { BML_CODES };
