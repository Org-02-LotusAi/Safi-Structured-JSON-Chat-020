# SAFI Chat 020 — Independent dogfood session (SOW §11, A01 / A14)

Purpose: an independent, non-developer tester uses the **published HTTPS site** for at least 30 minutes against the real
OpenAI API. The developer may explain the product but must not substitute a prepared video, hard-coded responses, or
developer-only operation. This file is a blank form plus a script; nothing here is filled in yet, so A01 and A14 are
`PENDING_HUMAN` in `ACCEPTANCE.json`.

## Before the session (operator)

- [ ] Stack deployed from the frozen Git SHA; `npm run verify:live` has been run and is PASS (or blocked reason recorded).
- [ ] URL has a valid public certificate (Caddy on a domain, or `npm run share:tunnel`; a tunnel URL is temporary).
- [ ] Tester has the pilot username and password (shared privately). `PILOT_API_CALL_CAP` leaves room for the session
      (default cap 40; the script below uses about 12).
- [ ] Observer is present and has this form.

## Observer form

| Field | Value |
|---|---|
| Tester name / identity | |
| Tester is not a developer of this product (yes/no) | |
| Exact HTTPS URL used | |
| Git SHA deployed | |
| Session start (UTC) | |
| Session end (UTC) | |
| Total minutes of hands-on use (must be 30 or more) | |
| Browser and version | |
| Device / OS | |
| Observer name | |

## Step script for the tester

Follow in order. The observer ticks each step, copies request IDs, and notes anything surprising. Request IDs appear in
each answer's metadata (**OpenAI request ID**); copy the `req_...` value.

| # | Step | Done | OpenAI request ID | Observation |
|---|---|---|---|---|
| 1 | Open the URL. Confirm the padlock shows a valid certificate. Sign in with the pilot credentials. | | n/a | |
| 2 | With reply format **Summary**, ask a question (for example "Explain what a message queue is in two sentences."). | | | |
| 3 | Ask a follow-up that depends on the first answer ("Now give an everyday example of that."). Check it uses the earlier context. | | | |
| 4 | Ask a third question that refers back to something you said earlier in step 2 or 3. | | | |
| 5 | Open **Structured data** on one answer. Note the Schema ID, version, SHA-256 prefix, and "Ajv 2020: PASS". | | | |
| 6 | Switch the reply format to **Tasks**. Ask for a plan ("Plan my Saturday: three tasks."). Confirm a task list with priorities appears. | | | |
| 7 | **Screenshot of the Summary result** (with metadata visible). File name: | | | |
| 8 | **Screenshot of the Tasks result** (with metadata visible). File name: | | | |
| 9 | Reload the page (F5). Confirm you are still signed in. Ask one more question. | | | |
| 10 | Click **New conversation**; ask a question; confirm it does not know the earlier chat. | | | |
| 11 | Try something the product should refuse or limit (very long text over 4,000 characters is blocked by the box; try a request the model may decline). Record what the screen showed. | | | |
| 12 | Free use: keep using the chat naturally until at least 30 minutes have passed since step 1. Note the usage counter (top right) at the end. | | | |
| 13 | Sign out. Confirm the login screen returns. | | n/a | |

## Request IDs captured (all)

| # | Schema | Time (UTC) | `req_...` ID |
|---|---|---|---|
| | | | |

## Screenshots

| Schema | File | Taken at (UTC) |
|---|---|---|
| Summary | | |
| Tasks | | |

Save screenshots under `evidence/dogfood/<date>/` and list them in `evidence/MANIFEST.md`.

## Defects and observations

| # | What happened | Steps to reproduce | Severity (blocker / major / minor) | Screenshot |
|---|---|---|---|---|
| | | | | |

Visible defect count: ______ (write 0 if none)

## Sign-off

- Tester statement: "I completed at least 30 minutes of hands-on use without developer intervention after setup." (yes / no)
- Developer intervention needed during the session (describe, or "none"):
- Observer signature and date:
- Tester signature and date:

SAFI alone decides acceptance. A completed form does not by itself make A01 or A14 `PASS`: update `ACCEPTANCE.json`
and `evidence/MANIFEST.md` only with the real, committed evidence.

---

# Newcomer onboarding rehearsal (README only, SOW §11)

Purpose: prove that a person who has never seen the project can reach a working chat in 30 minutes or less using **only
the README** (the "SOW §8 operator sequence" section), with no developer help. Nothing here is filled in yet; in
`ACCEPTANCE.json` this is `sow_section_11.onboarding_rehearsal` = `PENDING_HUMAN`.

| Field | Value |
|---|---|
| Person (not a developer of this product) | |
| Start (UTC) | |
| End (UTC) | |
| Machine / OS / Node version / Docker version | |
| Git SHA cloned | |
| Path used (A: everything in Docker, or B: NATS in Docker + `npm run start`) | |
| Minute at which a working chat was reached (a real answer on screen) | |
| Where they got stuck (step, error text, how long) | |
| Anything they had to ask the developer (must be "nothing" to pass) | |
| Result: PASS only if working chat reached in 30 minutes or less, README only, no developer help | |

Commands run, in order (the person pastes exactly what they typed, with the minute each finished):

| # | Command | Minute finished | Worked first time (yes/no) | Note |
|---|---|---|---|---|
| | | | | |

Observer signature and date:

# Recovery drill on the real-OpenAI deployment (SOW §11)

The committed drill evidence (`evidence/recovery/`) used a **fake** upstream on a local machine. This section records the
same drill on the real deployment. In `ACCEPTANCE.json` this is `sow_section_11.recovery_on_live_deployment` = `BLOCKED`
until a real key and deployment exist. Do not run it during the 30-minute dogfood session (it stops the worker and
restarts NATS).

Operator steps (from the repository root, on the host that runs the compose stack, with the real `.env`):

1. `npm run stack:up:dev` (or confirm it is running); confirm `OPENAI_BASE_URL` is empty in `.env`.
2. `DRILL_BASE_URL=https://<the URL users use> npm run drill:recovery` (PowerShell: `$env:DRILL_BASE_URL="https://..."; npm run drill:recovery`).
   Use `DRILL_STRICT_TLS=1` when the URL has a real certificate.
3. Confirm every line is PASS and that the baseline and the post-restart chats show `req_...` OpenAI request IDs in the UI
   (open the site, ask one question after the drill, copy the **OpenAI request ID**).

| Field | Value |
|---|---|
| Operator | |
| Date / start-end (UTC) | |
| Git SHA deployed (and `git_dirty` in the report must be `false`) | |
| URL | |
| Report file under `evidence/recovery/` | |
| Baseline chat OpenAI request ID | |
| After worker restart: new chat succeeded (OpenAI request ID) | |
| After NATS restart: receipts preserved and new chat succeeded (OpenAI request ID) | |
| Worker-down result was `worker_unavailable` with no false success (yes/no) | |
| Overall (PASS / FAIL) | |

