# SAFI Chat 020 — Structured JSON Chat over NATS to OpenAI

## What this product does

SAFI Chat is a small web chat. You sign in, pick one of two **reply formats** (a short *summary*, or a *task list*), and
talk to an AI model. Every answer you see has been checked, field by field, against a fixed JSON schema before it reaches
the screen. If the model returns something that does not match, you see a red **REJECTED** card instead of a fake
success. Under each answer the page shows which schema (ID, version, SHA-256 digest) was used and whether validation passed.

Behind the page, the message does not go straight to the AI. It travels through a real message bus (NATS):

```
 Browser (assistant-ui chat)
    │  HTTPS  (cookie login, CSRF header, strict request validation)
    ▼
 Server (Fastify)  ── validates input, binds fixed test GUIDs/context, applies rate + call caps
    │  NATS core request/reply   subject safi.chat.request.v1   (30 s deadline)
    ▼
 Worker (Node)     ── picks the approved schema, calls OpenAI Responses API (strict structured output),
    │                  re-validates the result with Ajv, replies with a typed result or typed error
    ▼
 OpenAI API  (gpt-6-luna by default)

 Server ──► NATS JetStream stream SAFI_CHAT_AUDIT (redacted receipt, 7-day retention) before answering the browser
```

```mermaid
flowchart LR
  B[Browser<br/>assistant-ui] -- HTTPS --> S[Server<br/>Fastify]
  S -- "NATS request/reply<br/>safi.chat.request.v1" --> W[Worker]
  W -- "Responses API<br/>strict json_schema" --> O[(OpenAI)]
  S -- "JetStream receipt<br/>SAFI_CHAT_AUDIT" --> N[(NATS + JetStream)]
  W --- N
```

What it is **not**: it is a one-pilot-user demonstration of the SAFI Chat standard, not a production chat product (see
[Scope limits](#scope-limits)). The wire format is documented in `docs/CONTRACTS.md`, the browser API in `openapi.yaml`,
and the requirements in `docs/SOW-020.md`.

## Quick start (about 30 minutes, README only)

### 0. Prerequisites

| Need | Why | Check |
|---|---|---|
| Node.js 22+ (24 recommended) and npm | build and run | `node -v` |
| Git | clone | `git --version` |
| Docker + Docker Compose v2 | run NATS (and optionally everything) | `docker compose version` |
| An OpenAI API key with access to `gpt-6-luna` and a spend cap | real answers | platform.openai.com |
| A pilot username and password you choose | login | — |

Without an OpenAI key you can still run the whole automated test-suite and the browser end-to-end test: they use a fake
upstream that is part of the tests only. A real conversation and `npm run verify:live` need the real key.

### 1. Install and test (5 min)

```bash
git clone <this repository> safi-chat-020 && cd safi-chat-020
npm ci
npm run nats:fetch        # downloads a pinned nats-server binary into .tools/ (used by the tests)
npm run test              # unit, contract, server and worker tests; no Docker, no OpenAI needed
```

### 2. Configure (3 min)

```bash
cp .env.example .env      # Windows PowerShell: Copy-Item .env.example .env
```

Edit `.env` and set at least:

| Variable | Meaning | Default / limit |
|---|---|---|
| `PILOT_USERNAME`, `PILOT_PASSWORD` | the single login (password at least 12 characters) | required |
| `SESSION_SECRET` | signs session cookies, at least 32 random characters | required |
| `SESSION_TTL_MIN` | session lifetime | 120 |
| `OPENAI_API_KEY` | worker only; never sent to the server container or browser | required for real answers |
| `OPENAI_MODEL` | model name | `gpt-6-luna` |
| `OPENAI_BASE_URL` | leave empty for real OpenAI; anything else marks the stack "custom" | empty |
| `OPENAI_TIMEOUT_MS` | per-call timeout | 25000 |
| `MAX_OUTPUT_TOKENS` | model output cap | 512 (max 512) |
| `USER_RATE_PER_MIN` | requests per minute per user | 10 (max 10) |
| `PILOT_API_CALL_CAP` | total OpenAI calls the pilot may use; persisted in `DATA_DIR/usage.json` | 40 |
| `MAX_INPUT_CHARS`, `MAX_TURNS`, `BODY_LIMIT_BYTES` | input caps | 4000, 8, 16384 |
| `NATS_URL` | where server and worker find NATS | `nats://127.0.0.1:4222` |
| `NATS_USER`, `NATS_PASS` | optional NATS authentication (enabled in compose when `NATS_USER` is set) | empty |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | HTTPS certificate for the server | `./infra/certs/dev.*` |
| `HOST`, `PORT` | listen address | `0.0.0.0`, `8443` |
| `TRUST_PROXY` | `true` only behind a TLS-terminating proxy | `false` |
| `DATA_DIR` | usage counter location | `./data` |
| `SAFI_DOMAIN` | public domain for the `caddy` profile | empty |

Create a development certificate (self-signed, `localhost` only):

```bash
npm run certs:dev
```

### 3. Run it

**Option 1 — everything in Docker (recommended).**

```bash
docker compose --env-file .env -f infra/docker-compose.yml up -d --build
curl -k https://localhost:8443/healthz        # {"ok":true}
```

Always pass `--env-file .env`: Compose otherwise looks for `infra/.env`, and `NATS_USER`/`NATS_PASS` would not reach
the NATS container. Services: `nats`, `worker`, `server` (each stoppable on its own, for example
`docker compose --env-file .env -f infra/docker-compose.yml stop worker`). NATS publishes no host port. If your
OpenAI endpoint is a local mock on the host, use `OPENAI_BASE_URL=http://host.docker.internal:<port>/v1`.

**Option 2 — NATS in Docker, server and worker from source.**

```bash
docker compose --env-file .env -f infra/docker-compose.yml -f infra/docker-compose.dev.yml up -d nats   # NATS on 127.0.0.1:4222
npm run build
npm run start                                   # worker + server with prefixed logs; Ctrl+C stops both
```

Then open <https://localhost:8443>. Your browser warns about the self-signed certificate; that is expected for the dev
certificate. Sign in, choose a reply format, and send a message. After each answer open **Structured data** to see the
JSON and the schema ID / version / digest / "Ajv 2020: PASS" line.

### 4. Check the real thing (needs the real OpenAI key and a valid-TLS URL)

```bash
VERIFY_BASE_URL=https://your-public-url PILOT_USERNAME=... PILOT_PASSWORD=... NATS_URL=nats://127.0.0.1:4222 npm run verify:live
```

It runs the three-turn conversation, both schemas, the rejection probes, the duplicate-request check, captures a real
NATS request and reply, reads the JetStream receipts, and writes `evidence/live/<timestamp>/report.json`. Exit code 0 is
PASS, 1 is FAIL, **2 is BLOCKED** (it refuses to run when the URL is not HTTPS, the stack is unreachable, or the worker
is not backed by the real OpenAI API). BLOCKED means nothing was verified.

## Commands

| Command | What it does |
|---|---|
| `npm ci` | install exact locked dependencies |
| `npm run test` | Vitest: schemas, worker, server, NATS integration |
| `npm run test:e2e` | Playwright Chromium over real HTTPS; starts its own NATS, worker, server and a **fake** OpenAI (test only). Needs `npm run build` first and `npx playwright install chromium` once |
| `npm run build` | compile shared/server/worker, build the web app |
| `npm run start` | run worker and server from `dist` |
| `npm run certs:dev` | create the self-signed dev certificate |
| `npm run nats:fetch` | download the pinned nats-server for tests |
| `npm run schemas:check` | verify schema digests and the strict-keyword allowlist |
| `npm run verify:live` | live acceptance checks against a deployed stack (see above) |
| `npm run drill:recovery` | compose drill: stop worker, restart worker, restart NATS, check receipts |
| `npm run share:tunnel` | temporary public HTTPS URL for a local stack (see below) |
| `docker compose --env-file .env -f infra/docker-compose.yml up -d --build` | NATS + worker + server in containers |

## Getting a real HTTPS URL

The pilot needs an HTTPS URL with a valid certificate (SOW §2). Two supported ways:

**Option A — a VM with your own domain (the durable way).** Point a DNS record at the VM, put `SAFI_DOMAIN=chat.example.com`
in `.env`, open ports 80 and 443, and run:

```bash
docker compose --env-file .env -f infra/docker-compose.yml --profile public up -d --build
```

Caddy obtains and renews a real certificate and proxies to the server over the internal network. Keep `TRUST_PROXY=false`
unless you remove the server's own TLS and set `TRUST_PROXY=true` (then the server serves plain HTTP behind Caddy).

**Option B — a Cloudflare quick tunnel (no domain needed).** With the stack running on `https://localhost:8443`:

```bash
npm run share:tunnel
```

It runs `cloudflared tunnel --url https://localhost:8443 --no-tls-verify` (install `cloudflared` first) and prints a
`https://<random>.trycloudflare.com` URL with a valid public certificate. The URL is temporary: it changes on every run
and dies when you press Ctrl+C. Use it for demos and for the dogfood session; do not record it as permanent. Anyone with
the URL can reach the login page, so keep the pilot password private.

## Operating the stack

* **Stop or restart the worker**: `docker compose --env-file .env -f infra/docker-compose.yml stop worker` / `start worker`.
  While it is down the UI shows "The AI worker is offline" and nothing is faked.
* **Restart NATS**: `... restart nats`. JetStream receipts live in the `nats-data` volume and survive. Requests sent
  during the few seconds the clients take to reconnect can time out as `worker_unavailable`; send the message again.
* **Recovery drill** (`npm run drill:recovery`): automates the three actions above against compose and checks the results.
  It briefly publishes NATS on `127.0.0.1:4222` via `infra/docker-compose.dev.yml` to count receipts. Output goes to
  `evidence/recovery/`.
* **Pilot call cap**: reset by deleting `DATA_DIR/usage.json` (compose: the `server-data` volume) while the server is stopped.
* **Secrets**: `.env` is gitignored. The OpenAI key is only given to the worker; the compose file blanks it for the server.

## Troubleshooting by error code

The UI shows the code on every error card. `retryable` tells you whether sending again can help.

| Code | HTTP | Meaning | What to do |
|---|---|---|---|
| `unauthenticated` | 401 | session missing or ended (also after logging in elsewhere: one session at a time) | sign in again |
| `ingress_rejected` | 400 / 403 | request body malformed, unknown field, too large, or CSRF header missing | reload the page; do not call the API by hand without the CSRF header |
| `schema_rejected` | 400 | unknown schema ID or digest mismatch | reload to refresh the reply-format list |
| `routing_rejected` | 403 / 404 | conversation not owned by this session, or unknown API route | start a new conversation |
| `user_rate_limited` | 429 | more than the per-minute limit, or too many failed logins | wait a minute |
| `cap_exceeded` | 429 | pilot OpenAI call cap reached | raise `PILOT_API_CALL_CAP` or reset `usage.json` |
| `duplicate_in_flight` | 409 | same request ID is still being processed | wait for it |
| `upstream_ambiguous` | 409 | an earlier attempt may have reached OpenAI; it is never retried automatically | send a new message |
| `worker_unavailable` | 504 | no worker answered within 30 s (or none subscribed) | `docker compose ... ps`; start the worker; check `NATS_URL`/credentials in worker logs |
| `rate_limited` | 503 | OpenAI returned 429 | wait and retry; check OpenAI quota |
| `upstream_timeout` | 504 | OpenAI did not answer within `OPENAI_TIMEOUT_MS` | retry; raise the timeout carefully (the NATS deadline is 30 s) |
| `upstream_network` | 502 | worker could not reach OpenAI | check outbound network from the worker container |
| `upstream_error` | 502 | OpenAI returned an error | read the worker log (status code only, no secrets) |
| `refusal` | 422 | the model declined to answer | rephrase |
| `incomplete` | 422 | the answer hit the output-token cap | ask for something shorter |
| `invalid_model_output` | 502 | model output failed schema validation and was discarded (the REJECTED card) | retry; if persistent, report it |
| `audit_failed` | — | the JetStream receipt could not be written; the answer is shown with an "audit failed" badge | check NATS/JetStream health |

Start-up problems:

| Symptom | Fix |
|---|---|
| `server failed to start: PILOT_PASSWORD ... at least 12 characters` | fix `.env` |
| `TLS_CERT_FILE and TLS_KEY_FILE are required` / cannot read TLS files | `npm run certs:dev`; in compose the cert is mounted from `infra/certs/` |
| `nats-server not found ... npm run nats:fetch` | run `npm run nats:fetch` (tests only) |
| `schema registry invalid` | a schema file changed; schemas are immutable, restore them from git |
| Compose: worker/server restart in a loop with an auth error | `NATS_USER`/`NATS_PASS` must match for all three services; use `--env-file .env` |
| `usage.json` corrupt, server refuses to start | delete or repair `DATA_DIR/usage.json` |
| `npm run test:e2e` says `dist missing` | run `npm run build` |
| `verify:live` prints BLOCKED | read the reason; it never partially passes |

## Acceptance and evidence

* `ACCEPTANCE.json` — A01–A14 with honest status (`PASS`, `FAIL`, `BLOCKED`, `PENDING_HUMAN`) and evidence paths.
* `DOGFOOD.md` — the observer form and 30-minute step script for the independent tester (SOW §11).
* `evidence/MANIFEST.md` — every evidence file, how it was produced, and what it does not prove.

## Scope limits

Deliberately out of scope (SOW §4, §7, §12): multi-user accounts or grants, production OAuth/auth systems, Supabase,
Windmill, MCP, the Kernel, real Son-of-Root GUID issuance (the four GUIDs are labelled test-only fixtures), Kernel
History / Logical Time / Final certification (JetStream receipts and Ajv PASS are operational evidence only),
persistent transcript ownership (thread history in the browser is lost on reload; the server keeps the last eight turns
per conversation in memory and loses them on restart), streaming, tools or function calls, a public NATS port, and
SAFI-managed hosting. Sessions, the rate limiter and the idempotency cache are in memory; the API-call cap is persisted.
Also excluded: the full Z Kernel, local Logical Time, Draft/Final certification, a generalized schema compiler, file uploads, speech, Root context navigation, the Meeting Manager/Moderator, and enterprise production hardening or SAFI-owned hosting. No claims beyond the pilot. Only SAFI issues formal acceptance.
