# Cole Call Center — Architecture

Cole is an AI debt collection agent that makes outbound phone calls, converses in real-time with debtors in Argentine Spanish, and logs results to Google Sheets, email, and WhatsApp.

---

## 1. Architecture Overview

```
POST /api/calls/outbound
        │
        ▼
  Twilio dials number
        │
        ▼
  Debtor answers → Twilio POSTs to /voice/incoming
        │
        ▼
  Server returns TwiML: <Connect><Stream url="wss://.../voice/stream"/>
        │
        ▼
  Twilio opens WebSocket → /voice/stream
        │
   ┌────┴────────────────────────────────────────┐
   │           Media Stream (WebSocket)          │
   │                                             │
   │  Twilio sends μ-law audio chunks            │
   │       │                                     │
   │       ▼                                     │
   │  Deepgram STT (real-time)                   │
   │       │  transcript                         │
   │       ▼                                     │
   │  Claude Haiku (streaming, sentence-by-sentence) │
   │       │  text sentences                     │
   │       ▼                                     │
   │  ElevenLabs TTS (ulaw_8000 stream)          │
   │       │  μ-law audio chunks                 │
   │       ▼                                     │
   │  Twilio plays audio to debtor               │
   └─────────────────────────────────────────────┘
        │
        ▼
  Call ends → Twilio POSTs to /voice/status
        │
        ▼
  Claude Haiku analyzes full transcript
        │
        ▼
  Report sent to: Email + WhatsApp + Google Sheets (parallel)
```

---

## 2. Media Streams WebSocket

### How it works

Twilio Media Streams is a bidirectional WebSocket between Twilio's infrastructure and our server. It replaces the old `<Gather>/<Play>` pattern.

**Key difference from old architecture:**
- Old: Twilio does STT → sends text via webhook → server generates audio URL → Twilio fetches and plays
- New: Twilio sends raw audio → server does STT → server streams audio back through WebSocket

### WebSocket message flow

**Twilio → Server (inbound):**
```json
// 1. Connection established
{ "event": "connected", "protocol": "Call", "version": "1.0.0" }

// 2. Stream starts — contains callSid
{ "event": "start", "start": { "callSid": "CA...", "streamSid": "MZ..." } }

// 3. Audio chunks (μ-law 8kHz, base64-encoded)
{ "event": "media", "media": { "track": "inbound", "payload": "<base64>" } }

// 4. Call ended
{ "event": "stop" }
```

**Server → Twilio (outbound):**
```json
// Send audio to debtor (μ-law 8kHz, base64-encoded)
{ "event": "media", "streamSid": "MZ...", "media": { "payload": "<base64>" } }

// Barge-in: stop current playback immediately
{ "event": "clear", "streamSid": "MZ..." }
```

### TwiML trigger

`/voice/incoming` returns:
```xml
<Response>
  <Connect>
    <Stream url="wss://callcenter-production-bb44.up.railway.app/voice/stream"/>
  </Connect>
</Response>
```

### WebSocket server setup

The WebSocket server runs on the same port as the HTTP server using the `upgrade` event:

```js
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/voice/stream') {
    wss.handleUpgrade(req, socket, head, (ws) => handleMediaStream(ws));
  }
});
```

**File:** `src/routes/media-stream.js` — `handleMediaStream(ws)`

---

## 3. Deepgram STT

### Configuration

```js
client.listen.v1.connect({
  model: 'nova-2',
  language: 'es-419',      // Latin American Spanish
  encoding: 'mulaw',       // accepts raw μ-law directly from Twilio — no conversion needed
  sample_rate: 8000,
  channels: 1,
  punctuate: true,
  interim_results: false,
  endpointing: 300,        // ms of silence → send final transcript
})
```

### Audio pipeline

Twilio sends μ-law audio → we forward chunks raw to Deepgram (same format, no conversion).  
`audioConverter.js` exists as a utility but is not in the active pipeline.

### Message parsing (critical)

Deepgram's SDK `v1.connect()` fires raw WebSocket `message` events. The data arrives as a **string, Buffer, or parsed object** depending on the environment. Must normalize before accessing fields:

```js
conn.on('message', (data) => {
  if (typeof data === 'string') data = JSON.parse(data);
  if (Buffer.isBuffer(data)) data = JSON.parse(data.toString());
  // now data is a JS object
});
```

**Without this, `data.type` is undefined and no transcripts are ever processed.**

### Transcript extraction

```js
const messageType = String(data?.type || '').toLowerCase();
if (messageType === 'results') {
  const text = (
    data?.channel?.alternatives?.[0]?.transcript ||
    data?.result?.channel?.alternatives?.[0]?.transcript ||
    data?.results?.channels?.[0]?.alternatives?.[0]?.transcript ||
    ''
  ).trim();

  if (text) onTranscript(text);  // no isFinal filter — interim_results:false handles it
}
```

**Why no `isFinal` check:** With `interim_results: false`, Deepgram only sends final transcripts. Adding `&& isFinal` was redundant and caused transcripts to be silently dropped when `is_final` wasn't at the expected path in the message object.

### Barge-in

Deepgram fires a `SpeechStarted` event when it detects the user starting to speak. The handler:
1. Sends `{"event": "clear"}` to Twilio → stops Cole's audio immediately
2. Calls `cancelCurrentResponse()` → sets a `cancelled` flag that stops the ElevenLabs stream loop

**File:** `src/services/deepgram.js`

---

## 4. Claude Response Generation

### Model and settings

```js
client.messages.stream({
  model: 'claude-haiku-4-5',
  max_tokens: 60,
  system: buildSystem(debtorInfo),
  messages: history,
})
```

Haiku is used for low latency (~300-800ms to first token). `max_tokens: 60` enforces short responses, which is also enforced in the system prompt ("Máximo 2 oraciones por respuesta").

### Sentence-by-sentence streaming

Claude streams tokens. The code detects sentence boundaries (`. ! ?` followed by a space) and calls `onSentence()` as soon as each sentence is complete:

```js
const SENTENCE_END = /^(.*?[.!?])\s/;

for await (const event of stream) {
  buffer += event.delta.text;
  while ((match = SENTENCE_END.exec(buffer)) !== null) {
    await onSentence(match[1].trim());
    buffer = buffer.slice(match[0].length);
  }
}
// flush final fragment without punctuation
if (buffer.trim()) await onSentence(buffer.trim());
```

This means ElevenLabs starts generating audio for the first sentence while Claude is still generating the second. **Latency to first audio ≈ time_to_first_sentence + ElevenLabs_latency.**

### System prompt context

Each call gets a context block injected below the cached system prompt:

```
=== INFORMACIÓN DEL DEUDOR ===
Nombre: Juan Pérez
Cuenta: ACC-001
Monto: cien mil pesos       ← converted to words via amountToWords()
Mora: 45 días
```

The system prompt itself is cached with `cache_control: ephemeral` to avoid re-sending tokens on every turn.

### Amount in words

`amountToWords()` in `claude.js` converts numeric amounts to natural Spanish:
- `100000` → `"cien mil"`
- `1500000` → `"un millón quinientos mil"`

**File:** `src/services/claude.js`

---

## 5. ElevenLabs TTS

### Two modes

**Streaming (used in Media Streams pipeline):**
```js
streamTextToSpeechUlaw(text)  // output_format: 'ulaw_8000'
```
Returns a Node.js readable stream of raw μ-law bytes. Chunks are base64-encoded and sent to Twilio as `media` events.

**Static file (used in /custom calls):**
```js
textToSpeech(text)  // output_format: 'mp3_22050_32'
```
Saves complete MP3 to `temp/{uuid}.mp3`, returns the UUID. File auto-deletes after 10 minutes.

### Voice settings

```js
{
  stability: 0.45,
  similarity_boost: 0.80,
  style: 0.15,
  use_speaker_boost: true,
}
```

Model: `eleven_turbo_v2_5` (lowest latency ElevenLabs model).  
Latency param: `optimize_streaming_latency: 4` (maximum optimization).

### Why ulaw_8000

Twilio Media Streams expects raw μ-law audio at 8kHz. ElevenLabs can output this format directly, avoiding any audio conversion step. This is the key simplification of the Media Streams architecture.

**File:** `src/services/elevenlabs.js`

---

## 6. Google Sheets Integration

### Two separate uses

**1. Call triggering (scripts/test-call-sheet.js):**  
Reads the sheet to find a debtor row, validates `Estado = PENDIENTE`, initiates the call via the API, polls until completion, updates the row.

**2. Call reporting (src/services/googleSheets.js):**  
After every call, `appendCallReport()` adds a new row to a separate log sheet with the full analysis.

### Credentials parsing

The service account JSON is stored as a single-line string in `GOOGLE_SERVICE_ACCOUNT_JSON`. The private key inside has literal `\n` characters (escaped newlines). They must be unescaped before the auth library can use the key:

```js
const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
const auth = new google.auth.GoogleAuth({ credentials, scopes: [...] });
```

**Without this fix, Google Auth throws "No key or keyFile set" or similar.**

### Append flow

```js
sheets.spreadsheets.values.append({
  spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
  range: process.env.GOOGLE_SHEETS_RANGE || 'Calls!A:I',
  valueInputOption: 'RAW',
  insertDataOption: 'INSERT_ROWS',
  requestBody: { values: [[timestamp, name, callSid, semaphore, categorizacion, result, summary, keyMoments, nextAction]] },
})
```

**File:** `src/services/googleSheets.js`

---

## 7. Call Flow Diagram

```
Operator                    Server                  External Services
─────────                   ──────                  ─────────────────

POST /api/calls/outbound ──▶ Validate body
                             conversation.create()
                             twilio.calls.create() ──────────────────▶ Twilio API
                             Return { callSid }     ◀────────────────── { sid, status }
◀─────────────────────────── { success, callSid }

                                                     Twilio dials debtor
                                                     Debtor answers
                             ◀── POST /voice/incoming ── Twilio webhook
                             Return TwiML <Connect><Stream>
                             ──▶ POST /voice/incoming ──▶ Twilio

                             ◀══ WebSocket /voice/stream ══▶ Twilio Media Stream opens

                             ElevenLabs TTS (greeting) ──────────────▶ ElevenLabs
                             ◀─────────────────────────────────────── μ-law stream
                             ══▶ media events (base64 audio) ══▶ Twilio plays greeting

                        [Debtor speaks]
                             ◀══ media events (inbound audio) ══ Twilio
                             Forward audio ──────────────────────────▶ Deepgram STT
                             ◀───────────────────────────── transcript (final)

                             [Barge-in detected]
                             ══▶ { event: "clear" } ══▶ Twilio (stops playback)

                             Claude streaming ────────────────────────▶ Anthropic API
                             ◀─────────────────────── tokens (sentence by sentence)
                             ElevenLabs TTS ──────────────────────────▶ ElevenLabs
                             ◀─────────────────────────────────────── μ-law stream
                             ══▶ media events ══▶ Twilio plays Cole's response

                        [Repeat until hangup]

                             ◀── POST /voice/status (completed) ── Twilio
                             Claude analysis ─────────────────────────▶ Anthropic API
                             ◀──────────────────────────────── JSON analysis
                             Send report ─────────────────────────────▶ Resend (email)
                                         ─────────────────────────────▶ Twilio (WhatsApp)
                                         ─────────────────────────────▶ Google Sheets
```

---

## 8. Key Files

| File | Role |
|---|---|
| `server.js` | Express app + HTTP server + WebSocket upgrade handler |
| `src/routes/twilio.js` | `/voice/incoming` (returns Stream TwiML) + `/voice/status` (triggers report) |
| `src/routes/calls.js` | `/api/calls/outbound` (initiate call) + `/api/calls/custom` + `/api/calls/:sid` (status) |
| `src/routes/media-stream.js` | WebSocket handler — orchestrates Deepgram → Claude → ElevenLabs pipeline |
| `src/services/deepgram.js` | Deepgram STT connection, audio forwarding, transcript extraction |
| `src/services/claude.js` | Claude streaming + sentence detection + `amountToWords()` |
| `src/services/elevenlabs.js` | ElevenLabs TTS — streaming ulaw, streaming mp3, static file |
| `src/services/conversation.js` | In-memory session store keyed by CallSid (TTL: 1 hour) |
| `src/services/callReport.js` | Post-call analysis via Claude + fan-out to email/WhatsApp/Sheets |
| `src/services/googleSheets.js` | Append call report row to Google Sheet |
| `src/services/email.js` | Send call report via Resend |
| `src/services/whatsapp.js` | Send call report via Twilio WhatsApp |
| `src/services/audioConverter.js` | μ-law ↔ PCM16 utility (not in active pipeline) |
| `src/config/valentina.js` | System prompt, greeting template, company name |
| `src/config/bml-codes.js` | BML categorization codes (used in post-call report prompt) |
| `scripts/test-call-sheet.js` | Standalone script: read Sheet → call one debtor → update Sheet |

---

## 9. Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | Claude API key |
| `TWILIO_ACCOUNT_SID` | ✅ | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | ✅ | Twilio auth token |
| `TWILIO_PHONE_NUMBER` | ✅ | Outbound caller ID (E.164) |
| `ELEVENLABS_API_KEY` | ✅ | ElevenLabs API key |
| `ELEVENLABS_VOICE_ID` | ✅ | Voice ID for Cole |
| `DEEPGRAM_API_KEY` | ✅ | Deepgram STT API key |
| `BASE_URL` | ✅ | Public HTTPS URL (e.g. `https://callcenter-production-bb44.up.railway.app`) |
| `RESEND_API_KEY` | ✅ | Resend email API key |
| `REPORT_EMAIL` | ✅ | Email address for call reports |
| `WHATSAPP_FROM` | ✅ | Twilio WhatsApp sender (e.g. `whatsapp:+14155238886`) |
| `WHATSAPP_TO` | ✅ | WhatsApp recipient number |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | ✅ | Service account JSON as single-line string (single-quoted) |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | ⚠️ | Sheet ID for call report log (optional — skipped if absent) |
| `GOOGLE_SHEETS_RANGE` | ⚠️ | Sheet range, default `Calls!A:I` |
| `PORT` | ⚠️ | Server port, default `3000` |
| `COMPANY_NAME` | ⚠️ | Company name shown in logs, default `Financiera Sur` |

---

## 10. Known Issues and Workarounds

### Deepgram: transcript never fires
**Symptom:** Cole calls, debtor speaks, Cole doesn't respond.  
**Root cause:** `conn.on('message', data)` — `data` arrives as Buffer or string, not a JS object. Accessing `data.type` returns `undefined`, the `results` check never matches.  
**Fix:** Parse before processing:
```js
if (typeof data === 'string') data = JSON.parse(data);
if (Buffer.isBuffer(data)) data = JSON.parse(data.toString());
```

### Deepgram: `isFinal` filter silently drops transcripts
**Symptom:** Same as above, even after the Buffer fix.  
**Root cause:** `is_final` field path varies between Deepgram message formats. With `interim_results: false`, all messages are already final — the `isFinal` filter is redundant and dangerous.  
**Fix:** Use `if (text)` instead of `if (text && isFinal)`.

### Google Sheets: "No key or keyFile set"
**Symptom:** Auth fails when calling Sheets API from Railway.  
**Root cause:** `GOOGLE_SERVICE_ACCOUNT_JSON` stored in `.env` with single quotes. Dotenv preserves literal `\n` in the private key — `JSON.parse` keeps them as `\\n`, which the RSA library can't use.  
**Fix:** After parsing, normalize the key:
```js
credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
```

### Railway: WebSocket not upgrading
**Symptom:** Media Stream connects then immediately closes.  
**Root cause:** Railway needs the app to listen on `0.0.0.0` and the WebSocket upgrade must be on the same port as HTTP.  
**Fix:** Use `http.createServer(app)` + `server.on('upgrade', ...)` instead of `app.listen()`. Railway handles the port automatically via `PORT` env var.

### Cole starts mid-sentence
**Symptom:** First words of Cole's greeting are cut off.  
**Root cause:** `GREETING_TEMPLATE` was `"Hola, ¿hablo con {name}?"` but the system prompt told Cole to open with `"Hola [nombre], soy Cole, te llamo por un saldo pendiente."` — mismatch caused Claude to start from the middle of the scripted opening.  
**Fix:** `GREETING_TEMPLATE` now generates the full opening line: `Hola ${name}, soy Cole, te llamo por un saldo pendiente.`

### High latency between turns
**Observed:** ~2-4 seconds from end of user speech to first audio from Cole.  
**Breakdown:**
- Deepgram endpointing: ~300ms after silence
- Claude first token (Haiku): ~500-1000ms
- ElevenLabs first chunk: ~300-500ms
- Total: ~1.1-1.8s minimum, ~3s in practice

**Mitigations applied:**
- `model: eleven_turbo_v2_5` + `optimize_streaming_latency: 4`
- `model: claude-haiku-4-5` with `max_tokens: 60`
- Sentence-by-sentence streaming (ElevenLabs starts before Claude finishes)
- `endpointing: 300` (Deepgram cuts quickly after silence)

**Not yet implemented:** ElevenLabs WebSocket streaming (would save ~200ms per turn).

### Session lost on Railway restart
**Symptom:** If Railway restarts mid-call, session history is lost and Cole forgets context.  
**Root cause:** `conversation.js` uses an in-memory `Map` — not persistent.  
**Workaround:** None currently. For production, replace with Redis.

---

## Rollback

If the Media Streams version breaks:
```bash
git log --oneline          # find last stable commit on main
git revert HEAD            # revert last commit, or:
git checkout <stable-sha> -- src/routes/twilio.js src/routes/media-stream.js server.js
git commit -m "rollback: revert to Gather-based architecture"
git push origin main
```

The last stable Gather-based commit before Media Streams merge: `b6398cc`.
