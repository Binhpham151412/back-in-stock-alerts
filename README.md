# Back-in-stock alerts

[![CI](https://github.com/Binhpham151412/back-in-stock-alerts/actions/workflows/ci.yml/badge.svg)](https://github.com/Binhpham151412/back-in-stock-alerts/actions/workflows/ci.yml)

Customers leave their email on a sold-out product. When it really comes back, they get one email. Not zero, not two.

- **`GET /embed`** is an embeddable form (email + SKU) built to live in an iframe on any store. Use `?sku=` to lock it to one product. It shows a live product preview and resizes its iframe with `postMessage`.
- **`POST /api/requests`** takes `{ "email", "sku" }` as JSON. It returns `201` for a new request and `200 { result: "already_waiting" }` when one is already open. CORS is enabled.
- **`POST /webhooks/stock`** receives stock webhooks. It checks `X-Webhook-Secret`, verifies every restock against the stock API, and ignores duplicate deliveries.
- **`GET /admin`** is behind a password (sign-in page, or HTTP Basic for scripts). It lists every request with its status, when it was requested and when it was notified, plus the recent webhooks and what happened to each one. `GET /admin/requests.json` returns the same data.
- **The email** is responsive HTML with a plain-text part, sent in the Resend API format (`POST {RESEND_BASE_URL}/emails`).
- **`GET /`** is a small demo product page with the embed in an iframe, as a store would use it.

Stack: Node 24 with **no npm dependencies**. It uses `node:http` and the built-in `node:sqlite`, with SQLite in WAL mode stored in `DATA_DIR`.

## Run it

```bash
docker build -t back-in-stock .
docker run -p 3000:3000 \
  -e STOCK_API_URL=... -e STOCK_API_KEY=... \
  -e RESEND_API_KEY=... -e RESEND_BASE_URL=... \
  -e WEBHOOK_SECRET=... -e ADMIN_PASSWORD=... \
  back-in-stock
```

The app listens on `$PORT` (default 3000). The database is `/data/restock.db`. It survives `docker restart`. To keep it when the container is re-created, add `-v restock-data:/data`.

Without Docker (Node 22.13+):

```bash
cp .env.example .env   # fill it in
node --env-file=.env --disable-warning=ExperimentalWarning src/server.js
```

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `STOCK_API_URL` | yes | `GET {url}/{sku}` returns `{ quantity, in_stock, ... }`, and `GET {url}` returns the catalogue (Bearer `STOCK_API_KEY`) |
| `STOCK_API_KEY` | yes | Bearer token for the stock API |
| `RESEND_API_KEY` | yes | Bearer token for the email API |
| `RESEND_BASE_URL` | yes | Email API base URL; emails are sent to `{RESEND_BASE_URL}/emails` |
| `WEBHOOK_SECRET` | yes | Expected value of the `X-Webhook-Secret` header |
| `ADMIN_PASSWORD` | yes | Protects `/admin` |
| `PORT` | no | Default `3000` |
| `DATA_DIR` | no | Where the SQLite file lives (default `/data` in Docker, `./data` locally) |
| `EMAIL_FROM` | no | Sender, default `Restock Alerts <alerts@restock.example.com>` |
| `BRAND_NAME` | no | Name shown in the UI and email, default `Restock` |
| `STORE_URL` | no | Fallback "Shop it now" link when the sign-up page URL is unknown |
| `RECONCILE_SECONDS` | no | How often to re-check stock for SKUs with people waiting (default `300`) |
| `MAX_EMAIL_ATTEMPTS` | no | Send attempts before a request is marked `failed` (default `10`) |

## How customers get one email, not zero and not two

Each request moves through these states:

```
waiting ──(stock API confirms quantity > 0)──▶ queued ──▶ sending ──▶ notified
                                                  ▲          │
                                                  └─ retry ◀─┘ (5xx / timeout, with backoff) ──▶ failed after N attempts
```

1. **The database enforces "no duplicate open requests".** A partial unique index on `(email, sku) WHERE status IN ('waiting','queued','sending')` does this. Emails are trimmed and lower-cased, and SKUs are upper-cased. Six identical requests fired at once produce one row. Once a request has been notified, the same customer can sign up again.
2. **Webhooks are not trusted.** The secret is compared in constant time. The webhook's `quantity` is treated only as a hint. Nobody is emailed until `GET STOCK_API_URL/{sku}` confirms the item is in stock. A webhook that claims a restock the stock API doesn't confirm is recorded as *not confirmed* and sends nothing.
3. **Duplicate and concurrent deliveries are recognised.** The `event_id` is written to `webhook_events` (primary key) before the handler awaits anything. A second delivery arriving at the same moment therefore sees the row and is acknowledged with `200 { duplicate: true }`, with no side effects. If the stock API can't be reached, the event is marked `unverified`, the handler returns `503`, and a redelivery of that event is processed again.
4. **Each request can only be claimed once.** Every state change is a guarded `UPDATE ... WHERE status = '<expected>'`. Webhooks, retries and the reconciler can all race, and a request still moves `waiting → queued` once and `queued → sending` once.
5. **The email is frozen before it is first sent, and every retry resends the same bytes.** Before the first network call, the exact request is stored on the row: `Idempotency-Key: restock-alert-<request id>` plus the JSON body (from, to, subject, html, text). Every retry, including after a restart, sends that stored key and body unchanged. Later product updates or config changes (`EMAIL_FROM`, `BRAND_NAME`, …) don't touch a frozen payload, so one key is never paired with two different payloads. A 5xx, timeout or dropped connection is retried with exponential backoff (3s, 6s, 12s, … capped at 10 min, up to `MAX_EMAIL_ATTEMPTS`). If an attempt was accepted but the response was lost, the provider recognises the repeated key and doesn't send again.
6. **Restarts are survived.** The queue and the frozen payloads live in SQLite. On boot, any request left in `sending` goes back to `queued`, and the worker resends its frozen payload. Older databases are migrated in place, with new columns added on start-up.
7. **A missed webhook still gets delivered.** A reconciler re-checks the stock API every `RECONCILE_SECONDS` for SKUs that still have people waiting. Sign-ups also check stock straight away: if the item is already in stock, the customer is told on screen and gets the email at once, rather than waiting for a webhook that may never come.

### What this guarantees, and what it doesn't

- **At most one email per request** holds as long as the email provider honours `Idempotency-Key` for longer than our retry window. The test server does. Resend keeps keys for 24 hours, and retries here stop well within that unless `MAX_EMAIL_ATTEMPTS` is raised a lot. A provider that ignores the header could deliver twice if a response is lost.
- **At least one email** holds while the stock API eventually confirms the restock and the email API eventually accepts the send within `MAX_EMAIL_ATTEMPTS`. After that, the request is marked `failed`, with the last error shown in `/admin`. It is not silently dropped.
- What happens after the provider accepts the email (spam filters, bounces) is outside this app.

## Tests

Two jobs run on every push in GitHub Actions ([ci.yml](.github/workflows/ci.yml)): `e2e` (described below) and `docker`. The `docker` job builds the image, runs it with only the brief's env vars, checks the endpoints, and checks the data survives `docker restart` and re-creating the container on the same volume ([test/docker-smoke.sh](test/docker-smoke.sh)).

`test/e2e.js` runs the app against the challenge's own test server, started locally, and checks:

- a wrong webhook secret is rejected
- duplicate and concurrent sign-ups produce one request
- invalid input returns 400
- a phantom restock sends no email
- the same webhook delivered twice at once sends exactly one email per customer
- two injected HTTP 500s are retried and the customer gets exactly one email
- signing up while the item is in stock sends one email
- a sell-out webhook sends nothing
- killing the app with a send pending, then restarting it, delivers exactly one email
- `/admin` requires the password
- `/embed` can be framed
- the email is accepted but the response is lost: the retry reuses the same key and the identical body, and the inbox gets one email (the repeat shows as deduplicated)
- the app is killed while waiting for the email API, and the product details and sender/brand config change while it is down: after restart it resends the identical frozen key and body, and the inbox gets one email
- a database created by the previous version is migrated in place

```bash
git clone https://github.com/yitzi-farla/back-in-stock-challenge ../_ref/back-in-stock-challenge
HARNESS=../_ref/back-in-stock-challenge/harness/server.js node test/e2e.js
```

## Notes and limits

- It is designed for a single instance, since SQLite is a local file. Scaling out would mean moving to Postgres and claiming work with `SELECT ... FOR UPDATE SKIP LOCKED`. The state machine stays the same.
- Built with Claude Code (Claude Opus), with OpenAI Codex as a second reviewer.
