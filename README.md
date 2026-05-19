# Context.io — Backend API

The server-side companion to the **Context.io** Chrome extension. It accepts text + the user's profession/language/tone, asks Claude to produce a professional-context translation, and returns a strict JSON shape the extension renders.

The Anthropic API key lives **only** on this server. The extension never sees it.

---

## Endpoint

### `POST /translate-context`

**Request body** (JSON):

```json
{
  "text": "We need to derisk the runway before the next board meeting.",
  "profession": "Startup CFO",
  "sourceLanguage": "en",
  "targetLanguage": "es",
  "tone": "executive"
}
```

| Field            | Type   | Required | Notes                                                              |
| ---------------- | ------ | -------- | ------------------------------------------------------------------ |
| `text`           | string | yes      | Selected text. Max length controlled by `MAX_TEXT_LENGTH` in `.env`. |
| `profession`     | string | no       | Free-form domain label (e.g. "Cardiologist", "M&A Lawyer").        |
| `sourceLanguage` | string | no       | ISO code or `"auto"`. Defaults to `"auto"`.                        |
| `targetLanguage` | string | yes      | ISO code. `"auto"` is not allowed here.                            |
| `tone`           | string | no       | One of: `formal`, `neutral`, `conversational`, `academic`, `executive`, `plain`. Defaults to `neutral`. |

**Successful response** (200 JSON):

```json
{
  "professionalMeaning": "Reduce financial risk by extending the cash runway before presenting to the board.",
  "contextTranslation":  "Necesitamos reducir el riesgo financiero y extender el runway antes del próximo consejo.",
  "genericMistake":      "A generic translator would render 'runway' as 'pista de aterrizaje' (airport runway), losing the startup-finance meaning.",
  "keyTerms": [
    { "term": "derisk", "translation": "reducir el riesgo", "note": "finance idiom" },
    { "term": "runway", "translation": "runway / pista de caja", "note": "months of cash remaining" }
  ]
}
```

**Error response** (any non-2xx):

```json
{ "error": "Human-readable message." }
```

### `GET /health`

Returns `{ "ok": true, ... }`. Use for liveness probes.

---

## Running locally

### 1. Install Node.js 18+

```bash
node --version   # should print v18.x or higher
```

### 2. Install dependencies

```bash
cd context-io-backend
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Open `.env` and set at minimum:

```ini
ANTHROPIC_API_KEY=sk-ant-...          # from https://console.anthropic.com/
ALLOWED_ORIGINS=chrome-extension://<your-extension-id>
```

To find your extension ID, open `chrome://extensions`, enable Developer mode, and copy the ID shown under the Context.io card.

### 4. Run

```bash
npm run dev     # auto-restart on file changes (Node --watch)
# or
npm start       # plain run
```

You should see:

```
Context.io backend listening on http://localhost:8787 (env: development, model: claude-sonnet-4-6)
CORS allowlist: chrome-extension://<your-extension-id>
```

### 5. Test from the command line

```bash
curl -s http://localhost:8787/health
```

```bash
curl -s http://localhost:8787/translate-context \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Push the patient on pressors and re-check the lactate in 30.",
    "profession": "ICU Nurse",
    "sourceLanguage": "en",
    "targetLanguage": "es",
    "tone": "neutral"
  }' | jq
```

### 6. Wire up the Chrome extension

In the extension's `background.js`, set:

```js
const API_BASE_URL  = "http://localhost:8787";   // dev
const TRANSLATE_PATH = "/translate-context";
```

For production, replace `API_BASE_URL` with your deployed origin and add that origin to `ALLOWED_ORIGINS` on the server.

---

## Configuration reference

All values come from `.env` (see `.env.example`):

| Variable                  | Default                 | Purpose                                            |
| ------------------------- | ----------------------- | -------------------------------------------------- |
| `ANTHROPIC_API_KEY`       | *(required)*            | Your Anthropic key. Never exposed to clients.      |
| `ANTHROPIC_MODEL`         | `claude-sonnet-4-6`     | Model used for translation.                        |
| `PORT`                    | `8787`                  | Express port.                                      |
| `ALLOWED_ORIGINS`         | *(empty = allow all)*   | Comma-separated CORS allowlist.                    |
| `RATE_LIMIT_WINDOW_MS`    | `60000`                 | Rate-limit window in ms.                           |
| `RATE_LIMIT_MAX`          | `30`                    | Max requests per IP per window.                    |
| `MAX_TEXT_LENGTH`         | `4000`                  | Max characters in `text`.                          |
| `NODE_ENV`                | `development`           | Set to `production` when deploying.                |

---

## Project layout

```
context-io-backend/
├── .env.example
├── .gitignore
├── package.json
├── README.md
└── src/
    ├── server.js       # Express app, middleware, routes, error handler
    ├── config.js       # Loads + validates env vars
    ├── validate.js     # Pure validation for the request body
    └── anthropic.js    # Prompt, Claude API call, JSON normalization
```

---

## Security notes

- **No API keys in the extension.** Auth lives here only.
- **CORS allowlist.** Configure `ALLOWED_ORIGINS` for production; an empty value is permissive and intended only for local development.
- **Rate limiting.** Per-IP via `express-rate-limit`. Tune `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` to your traffic.
- **Input validation.** Strict allowlists for language and tone; hard cap on text length; control chars stripped.
- **Body size cap.** `express.json` is limited to 64 KB.
- **Helmet.** Default security headers enabled.
- **Error responses** never leak stack traces, internal paths, or upstream provider details.

---

## Deploying

The app is a plain Node server with no native deps — it runs anywhere Node 18+ runs (Render, Fly.io, Railway, Heroku, a VM, Docker, etc.). Make sure to:

1. Set `NODE_ENV=production`.
2. Set `ANTHROPIC_API_KEY` as an environment variable (not in source).
3. Set `ALLOWED_ORIGINS` to the production extension origin only.
4. Put it behind HTTPS (most platforms do this automatically).
