# Cole Call Center — API Reference

Base URL: `https://callcenter-production-bb44.up.railway.app`

All `/api/*` endpoints require a valid session cookie (`cole_session`) except where noted.
Rate limits are enforced per IP.

---

## Authentication

### POST /auth/login

Authenticate and receive a session cookie. Rate limited to **5 attempts / 15 min**.

**Body (form or JSON)**

| Field      | Type   | Required |
|------------|--------|----------|
| `password` | string | yes      |

**Example request**
```http
POST /auth/login
Content-Type: application/x-www-form-urlencoded

password=mysecretpassword
```

**Responses**

| Status | Description |
|--------|-------------|
| 302    | Redirect to `/` on success; sets `cole_session` cookie |
| 302    | Redirect to `/login?error=1` on wrong password |

---

## Calls

### POST /api/calls/outbound

Initiate a single outbound collection call immediately.

**Body (JSON)**

| Field              | Type   | Required | Validation              |
|--------------------|--------|----------|-------------------------|
| `to`               | string | yes      | E.164 format (`+549...`) |
| `debtor.name`      | string | yes      | 2–100 characters        |
| `debtor.amount`    | number | no       | Positive number         |
| `debtor.daysOverdue` | integer | no   | Positive integer        |
| `debtor.accountId` | string | no       | Free text               |

**Example request**
```json
POST /api/calls/outbound
{
  "to": "+5491112345678",
  "debtor": {
    "name": "Juan Pérez",
    "amount": 150000,
    "daysOverdue": 45,
    "accountId": "ACC-001"
  }
}
```

**Example response (200)**
```json
{
  "success": true,
  "callSid": "CA1234567890abcdef",
  "status": "queued",
  "to": "+5491112345678",
  "debtor": "Juan Pérez"
}
```

**Error responses**

| Status | Condition |
|--------|-----------|
| 400    | Missing fields, invalid phone format, invalid name/amount/daysOverdue |
| 403    | Outside call hours (10:00–17:00 Argentina time) |
| 502    | Twilio account or credential error |

---

## Deudores

### GET /api/deudores/:debtorName

Look up a debtor by name in Google Sheets and initiate a call immediately.

**Path params**

| Param        | Description                          |
|--------------|--------------------------------------|
| `debtorName` | Exact name as it appears in the sheet |

**Example request**
```http
GET /api/deudores/Juan%20P%C3%A9rez
```

**Example response (200)**
```json
{
  "success": true,
  "callSid": "CA1234567890abcdef",
  "status": "queued",
  "name": "Juan Pérez",
  "phone": "+5491112345678",
  "amount": 150000,
  "daysOverdue": 45
}
```

**Error responses**

| Status | Condition |
|--------|-----------|
| 400    | Phone not in E.164 format, invalid name/amount/daysOverdue in sheet |
| 404    | Debtor not found in sheet |
| 500    | Sheets read error or Twilio error |

---

## Call Queue

### POST /api/queue/batch

Start a campaign: enqueue multiple debtors and process calls sequentially with an 8-second gap. Cancels any pending items from a previous campaign. Rate limited to **10 campaigns / hour**.

**Body (JSON)**

| Field     | Type  | Required | Description                    |
|-----------|-------|----------|--------------------------------|
| `debtors` | array | yes      | Array of debtor objects        |

Each debtor object:

| Field        | Type   | Required | Validation       |
|--------------|--------|----------|------------------|
| `phone`      | string | yes      | E.164 format     |
| `name`       | string | yes      | 2–100 characters |
| `amount`     | number | no       | Positive number  |
| `daysOverdue`| integer| no       | Positive integer |
| `id`         | string | no       | UUID; auto-generated if omitted |

**Example request**
```json
POST /api/queue/batch
{
  "debtors": [
    { "phone": "+5491112345678", "name": "Juan Pérez", "amount": 150000, "daysOverdue": 45 },
    { "phone": "+5491187654321", "name": "María García", "amount": 75000, "daysOverdue": 12 }
  ]
}
```

**Example response (200)**
```json
{
  "ok": true,
  "queued": 2,
  "ids": ["uuid-1", "uuid-2"]
}
```

**Error responses**

| Status | Condition |
|--------|-----------|
| 400    | `debtors` missing or empty |

---

### GET /api/queue/status

Get current queue state, including per-item status.

**Example response (200)**
```json
{
  "pending": 1,
  "calling": 1,
  "done": 5,
  "error": 0,
  "cancelled": 0,
  "total": 7,
  "items": [
    { "id": "uuid-1", "status": "done",    "callSid": "CA...", "error": null },
    { "id": "uuid-2", "status": "calling", "callSid": "CA...", "error": null },
    { "id": "uuid-3", "status": "pending", "callSid": null,    "error": null }
  ]
}
```

---

### POST /api/queue/clear

Cancel all pending calls in the current campaign immediately.

**Example response (200)**
```json
{
  "ok": true,
  "cancelled": 3
}
```

---

## Monitoring

### GET /api/retries

List calls scheduled for automatic retry (triggered by no-contact BML codes: NADA, APAG, MENS, OCUP, NONO, CORT, VOLTA).

**Example response (200)**
```json
{
  "pending": 2,
  "entries": [
    { "phone": "+5491112345678", "retryAt": "2024-01-15T14:30:00.000Z", "attempts": 1 },
    { "phone": "+5491187654321", "retryAt": "2024-01-15T15:00:00.000Z", "attempts": 2 }
  ]
}
```

---

### GET /api/logs

Retrieve the last 50 log lines from the server.

**Example response (200)**
```
text/plain

[2024-01-15T12:00:00Z] [INFO] [Queue] Campaña iniciada — 10 deudores encolados
[2024-01-15T12:00:08Z] [CALL] +5491112345678 | Juan Pérez | queue-call
...
```

---

## Health

### GET /health

Public endpoint. Returns service status. Does **not** require authentication.

**Example response (200)**
```json
{
  "status": "ok",
  "service": "Cole Call Center — Media Streams",
  "timestamp": "2024-01-15T12:00:00.000Z",
  "services": {
    "twilio": true,
    "sheets": true,
    "claude": true,
    "elevenlabs": true,
    "deepgram": true
  }
}
```

---

## Call Hours

Outbound calls are only permitted between **10:00 and 17:00 Argentina time** (America/Argentina/Buenos_Aires). Requests outside this window receive:

```json
HTTP 403
{ "error": "Fuera de horario permitido. Llamadas permitidas entre 10:00 y 17:00 hs (Argentina)" }
```

## BML Result Codes

| Code  | Meaning                  | Auto-retry |
|-------|--------------------------|------------|
| PROM  | Payment promise made     | No         |
| NOPA  | No payment promise       | No         |
| NRED  | Number doesn't exist     | No         |
| VOLT  | Will call back           | Yes        |
| NADA  | No answer                | Yes        |
| APAG  | Phone off                | Yes        |
| MENS  | Went to voicemail        | Yes        |
| OCUP  | Line busy                | Yes        |
| NONO  | Refused to talk          | Yes        |
| CORT  | Call dropped             | Yes        |
| VOLTA | Said they'll call back   | Yes        |
