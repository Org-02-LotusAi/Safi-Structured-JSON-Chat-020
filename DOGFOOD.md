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
