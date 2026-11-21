# SAFI Chat 020 — Global Constraints & Contracts (binding for every task)

Source of truth: `docs/SOW-020.md`. If anything here conflicts with the SOW, the SOW wins — report it.

## Stack (frozen by SOW §3)
- Node active LTS (v24 on dev box), TypeScript, ESM (`"type":"module"`), npm workspaces: `shared`, `server`, `worker`, `web`.
- HTTP bridge: Fastify 5 (+ `@fastify/cookie`, `@fastify/static`). ONE authenticated `POST /api/chat`; also `POST /api/login`, `POST /api/logout`, `GET /api/session`, `GET /api/schemas`, `GET /api/status`, `POST /api/conversations` (new conversation). Static SPA hosting from `web/dist` in the same app.
- Transport: official NATS JS client v3 (`@nats-io/transport-node`, `@nats-io/jetstream`). Core request/reply for chat; JetStream for audit only.
- Validation: JSON Schema Draft 2020-12, `ajv/dist/2020` (Ajv 8) with `strict: true`, `allErrors: true`; every object `additionalProperties: false`. `ajv-formats` allowed.
- Model: official `openai` Node SDK, Responses API, `model = OPENAI_MODEL` (default `gpt-6-luna`), `text.format = {type:"json_schema", name, schema, strict:true}`, `store:false`, `max_output_tokens <= 512`, no tools, no streaming, SDK `maxRetries: 0` (never auto-retry), per-call timeout `OPENAI_TIMEOUT_MS` default 25000.
- UI: React + TS + Vite, Tailwind + shadcn/ui-style components, `@assistant-ui/react` with `useLocalRuntime` + a `ChatModelAdapter`. Browser talks only to backend over HTTPS. No NATS / OpenAI in browser.
- Tests: Vitest (root `vitest.config.ts`, tests under `tests/`), Playwright Chromium (`tests/e2e/`). Lockfile committed; exact versions (no `^`/`~`) in all package.json files.
- Commits: plain `git commit` as the configured git user. NO `Co-Authored-By` or any AI attribution trailer. Never commit secrets (`.env` is gitignored).

## Fixed test-only GUIDs (lowercase 32-hex, 128-bit) — `shared/src/guids.ts`
Clearly labelled TEST-ONLY, not Kernel-issued:
- `PILOT_SENDER_GUID      = "5afe0020000000000000000000000001"` (pilot human user)
- `OPENAI_SERVICE_GUID    = "5afe0020000000000000000000000002"` (OpenAI Guest Service)
- `PILOT_THREAD_GUID      = "5afe0020000000000000000000000003"`
- `PILOT_SUBJECT_GUID     = "5afe0020000000000000000000000004"`
- Context = `{ thread_guid: PILOT_THREAD_GUID, subject_guid: PILOT_SUBJECT_GUID, path: [PILOT_THREAD_GUID, PILOT_SUBJECT_GUID] }` (ordered).

## Schemas (`schemas/`, immutable once committed)
- `chat-request.schema.json`, `chat-result.schema.json`, `chat-error.schema.json`, `registry.json`, `reply-summary.v1.0.0.schema.json`, `reply-tasks.v1.0.0.schema.json`.
- Envelope common fields (all required, additionalProperties false):
  - `protocol: "safi.chat"` (const), `version: "0.1.0"` (const), `kind`: `"chat.request" | "chat.result" | "chat.error"` (const per schema)
  - `message_id` (string, 1–64 chars, pattern `^[A-Za-z0-9_-]+$`), `conversation_id` (same pattern), `in_reply_to` (request: `null`; result/error: the request `message_id` string)
  - `from_guid`, `to_guid`: pattern `^[0-9a-f]{32}$`
  - `context`: `{thread_guid, subject_guid, path: [guid, ...] (minItems 1, maxItems 8)}`
  - `schema_ref`: `{id, version}` (version pattern semver `^\d+\.\d+\.\d+$`), `schema_sha256`: `^[0-9a-f]{64}$`
  - `sent_at_utc`: string, format `date-time`, must end with `Z`
- Request: `body: { text: string 1..4000, history: [{role: "user"|"assistant", text: string 1..8000}] maxItems 16 }` (16 = 8 turns × 2 messages).
- Result: `status: "ok"`, `body`: object (validated separately against the selected reply schema), `model` string, `openai_request_id` string|null, `usage: {input_tokens:int, output_tokens:int}`.
- Error: `status: "error"`, `error: { code, message (<=500 chars, redacted), retryable: boolean }`. `code` enum: `ingress_rejected, schema_rejected, routing_rejected, refusal, incomplete, rate_limited, upstream_timeout, upstream_network, upstream_error, invalid_model_output, worker_unavailable, duplicate_in_flight, upstream_ambiguous, cap_exceeded, user_rate_limited, audit_failed, unauthenticated`.
- Reply contracts (OpenAI strict subset: only `type, properties, required, additionalProperties:false, enum, items, description`; every property required):
  - (A) `safi.reply.summary` `1.0.0`: `{reply: string, tone: "neutral"|"friendly", followup_needed: boolean}`
  - (B) `safi.reply.tasks` `1.0.0`: `{reply: string, tasks: [{task: string, priority: "high"|"normal"|"low"}], followup_needed: boolean}` (array may be empty)
- `registry.json`: `{ "registry_version": "1.0.0", "schemas": [ { "id", "version", "file", "sha256", "ui_choice": true, "label" } ] }`. sha256 = SHA-256 hex of the exact file bytes. Loader verifies every digest at startup and refuses to start on mismatch; also rejects any reply schema containing a keyword outside the strict allowlist above (plus `$schema`, `$id`, `title`).

## NATS
- Core subject `safi.chat.request.v1`, worker queue group `safi-openai-worker`. Request deadline 30000 ms.
- JetStream stream `SAFI_CHAT_AUDIT`, subject `safi.chat.audit.v1`, `max_age` 7 days, `max_bytes` 64 MiB, file storage. NATS subjects are transport only, NOT SAFI Subject GUIDs.
- Audit receipt (redacted — never prompt text, reply text, keys, cookies): `{receipt_version:"1", at_utc, conversation_id, message_id, in_reply_to, request_id, schema_ref, schema_sha256, outcome: "ok"|"error", error_code|null, model, openai_request_id|null, usage|null, latency_ms}`. Server publishes it with JetStream ack BEFORE returning the outcome to the browser; if the publish fails, browser gets the outcome plus `audit: "failed"` flag (and error code `audit_failed` is logged) — never silently.

## Browser API (`POST /api/chat`) request body — strict, unknown fields rejected with 400 before NATS/OpenAI
`{ request_id: uuid-v4 string, conversation_id: string, schema_id: string, schema_sha256?: 64-hex, text: string 1..4000 }`. Anything else (from_guid, to_guid, context, role, subject, model, schema object, …) ⇒ 400 `ingress_rejected`. Unknown `schema_id` or mismatched `schema_sha256` ⇒ 400 `schema_rejected`. `conversation_id` not owned by this session ⇒ 403 `routing_rejected`.
Response 200 on ok: `{ outcome:"ok", request_id, envelope: <chat.result>, validation: {envelope:"pass", body:"pass", validator:"ajv-2020"}, audit: "persisted"|"failed", api_calls_used, api_call_cap }`. Typed failure: HTTP 4xx/5xx/502/504 with `{ outcome:"error", request_id, error:{code,message,retryable}, envelope?: <chat.error>, audit }`.

## Limits & config (env, see `.env.example`)
`PILOT_USERNAME`, `PILOT_PASSWORD` (≥12 chars), `SESSION_SECRET` (≥32 chars), `SESSION_TTL_MIN`=120, `USER_RATE_PER_MIN`=10 (max 10), `PILOT_API_CALL_CAP`=40, `MAX_INPUT_CHARS`=4000, `MAX_TURNS`=8, `MAX_OUTPUT_TOKENS`=512 (max 512), `BODY_LIMIT_BYTES`=16384, `NATS_URL`, `NATS_USER`/`NATS_PASS` (optional), `OPENAI_API_KEY`, `OPENAI_MODEL`=gpt-6-luna, `OPENAI_BASE_URL` (optional), `OPENAI_TIMEOUT_MS`=25000, `TLS_CERT_FILE`/`TLS_KEY_FILE`, `HOST`=0.0.0.0, `PORT`=8443, `TRUST_PROXY`=false, `DATA_DIR`=./data. API-call counter persisted in `DATA_DIR/usage.json` so restarts don't reset the cap. Limits checked BEFORE any NATS publish / OpenAI call.

## Logging / secrets
Pino (Fastify logger) with redaction of `authorization`, `cookie`, `set-cookie`, `*.api_key`, `OPENAI_API_KEY`, and never log `body.text`, `history`, or reply bodies. Error messages surfaced to users are generic + code; no upstream raw error text containing keys.
