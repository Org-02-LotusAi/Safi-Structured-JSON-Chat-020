# Evidence manifest

Everything here was produced on the build machine (Windows 11, Node 24, Docker Desktop) **without** an OpenAI key.
No file in this folder is proof of a real OpenAI call. Status per acceptance test is in `../ACCEPTANCE.json`.

| Path | What it is | How it was produced | What it does not prove |
|---|---|---|---|
| `ui/*.png` (8) | Screenshots of login, empty chat, summary, tasks, refusal, REJECTED, mobile | Task 4 manual Playwright run against a local stack with a fake upstream | real OpenAI output |
| `e2e/01-three-turn-summary.png` … `07-after-reload.png` (7) | Screenshots saved by `npm run test:e2e` | `tests/e2e/chat.spec.ts`: real Chromium over real HTTPS (dev cert) to the built server, real nats-server, real worker process, fake OpenAI (test only). Overwritten on each run | real OpenAI output; a valid public certificate |
| `recovery/drill-2026-11-21T12-31-49-342Z.json` | PASS report of the recovery drill (worker stop/start, NATS restart, receipts persisted) | `npm run drill:recovery` against `docker compose --env-file .env -f infra/docker-compose.yml` (nats with auth enabled, worker, server containers built from the Dockerfile), fake OpenAI on the host, throwaway untracked `.env` | real OpenAI; a real domain |
| `recovery/drill-console.txt` | Console output of the same run | `tee` of the drill | same |
| `live/BLOCKED-2026-11-21.txt` | Record that `verify:live` refuses to run without a real-OpenAI-backed stack | run against a local stack via a throwaway cloudflared tunnel | that verify:live passes (it has not been run to PASS) |
| `live-selftest/report.json` | Output of the `verify:live` logic exercised against a local stack with a **fake** upstream (`VERIFY_SELFTEST_FAKE_UPSTREAM=1`) | `VERIFY_SELFTEST_FAKE_UPSTREAM=1 VERIFY_OUT_DIR=evidence/live-selftest npm run verify:live`; `overall` is `SELFTEST_ONLY`. One check is expected to FAIL there (the fake model does not echo "teal") | any acceptance; it only shows the script's probes, NATS capture and receipt checks work |
| `live/<timestamp>/report.json` | **Not yet present.** Will be written by `npm run verify:live` on a real deployment | — | — |
| `dogfood/<date>/` | **Not yet present.** Screenshots and the filled `DOGFOOD.md` from the independent tester | — | — |

Notes:

* Test results (Vitest, Playwright) are reproducible with `npm run test` and `npm run test:e2e`; they are not stored here.
* Secrets: none of these files contain keys, passwords, or cookies. The recovery report and self-test report contain only
  counts, outcomes, hashes and (self-test) fake request IDs such as `req_fake_1`.
* A temporary Cloudflare quick-tunnel URL was used during development to confirm valid-TLS reachability. It is dead and
  intentionally not recorded.
