# trained-assist-llm-ladder

OpenAI-compatible **model ladder** for small "service" LLM calls across trained-assist repos
(answer buttons, formatting, classifiers, summaries, routing). Cloudflare Worker — no VM.

Live: `https://llm-ladder.trainedassist.store`

## Ladders

`config/ladders.json`:

- **`deepseek`** (alias `service`) — small service calls; owner decision 2026-09-27, same for every role:

1. `opencode-go/mimo-v2.6-flash`
2. `opencode-go/deepseek-v4.1-flash`
3. `openrouter/nvidia/nemotron-3-super-120b-a12b:free` — free tier (issue #26, owner 2026-09-30):
   rides out a Go weekly-limit incident without paying the OpenRouter tail
4. `openrouter/inclusionai/ling-3.0-flash-sante:free` — free, second vendor
5. `openrouter/deepseek/deepseek-v4-flash-0731` — paid tail starts here ($0.021/$0.32 per M)
6. `openrouter/inclusionai/ling-3.0-flash` — paid, different vendor (InclusionAI), 2–7s ($0.021/$0.063)
7. `openrouter/xiaomi/mimo-v2.6-flash` — paid, third vendor ($0.14/$0.28)

(`opencode-go/muse-spark-1.3-contributor` was removed 2026-09-27 — owner: broken, drop it.)

- **`research`** — Hermes / opencode researcher runs (owner 2026-09-28), **split by role**:
  `research:explore` (the reading subagent — big docs, PDFs, pages) = Go `mimo-v2.6-flash` (1M ctx) →
  Go `deepseek-v4.1-flash` → paid `openrouter/google/gemini-2.5-flash-lite` as the degradation tail
  (issue #28, owner 2026-09-30: Go-first, `gemini-3.1-flash-lite` dropped — redundant paid rung of
  the same vendor); `research` / `:plan` / `:general` / `:review` (the thinking and
  writing main agent) = Go `mimo-v2.6-flash` (1M ctx) → Go `deepseek-v4.1-flash` → paid OpenRouter mimo.
  `gemini-2.5-flash` and `2.5-pro` are deliberately not in it (too expensive).

- **`doctor`** — strongest tier for playbook `doctor` steps when Claude/Codex are unavailable
  (owner decision 2026-09-28): Go MiMo-V2.6-Flash primary (τ²-bench airline 76.6%, above Kimi K2.7
  Code 71.7%), then *stronger* Go models instead of cheaper ones — `qwen3.7-plus` → `deepseek-v4-pro`
  (`qwen3.8-max` dropped — far too expensive) — and paid OpenRouter `xiaomi/mimo-v2.6-flash` last.

- **`free`** (alias `free-ladder`) — cheap/free rungs for agents that run on weak models
  (opencode as a client, pr-autofix): OpenCode Go cheap models first, OpenRouter `:free`
  fallback; order from the pr-autofix bench (2026-09-26). Streaming + tools supported.

Rungs are tried top-down:

- **Model health** — a failing rung is skipped for everyone: transient faults back off per model
  (15s → 30s → 60s … cap 5 min, each model its own counter); quota/limit errors skip for the
  classified TTL (`src/classify.js`). Exception: a TRANSIENT skip on a Go rung is capped at 30s
  after its last failure — a short Go wobble must not keep the fleet on the paid OpenRouter tail
  (money + a mid-run prompt-cache reset) for the full backoff. Real limits keep their TTL.
- **Two OpenCode Go keys** (`OPENCODE_GO_API_KEYS`) — a key-level fault (usage limit, 429,
  rejected key) rotates to the spare key and retries the same rung; a WEEKLY allowance parks that
  key for 6 h (`"limitName":"weekly"`), not the 15-minute rate-limit TTL. A rung that fails for a
  NON-key reason (timeout, empty answer, 500) gets ONE spare-key probe per call before the ladder
  leaves Go for paid OpenRouter — a silently throttled key looks exactly like a slow model, and
  staying on Go costs nothing. Context/config rejections never probe (the key cannot change them).
  When both keys are parked, every Go rung is skipped until the earliest key heals, so the ladder
  serves OpenRouter and returns to Go by itself. Every attempt entry carries the pool `key` index
  (`ok` / `error` / `key-rotated` / `key-probe`), so `/v1/state` and the Workers Observability
  logs show which key served. 503 / Bad Request never burn a key.
- **Guard** — empty content, or non-JSON when `response_format: json_object`, fails the rung.

State lives in one global Durable Object (`LadderState`) — strongly consistent across callers.

> Research / presentation / vision calls are NOT for this service — they stay on Gemini in their
> callers (owner: «gemini для рисеча и для презентаций он прямо гуд»).

## API

All endpoints except `/health` need `Authorization: Bearer <LADDER_TOKEN>`.

| Method | Path | |
|---|---|---|
| GET | `/health` | liveness + ladder names |
| GET | `/v1/models` | ladders as model ids (`deepseek`, `deepseek:review`, …) |
| GET | `/v1/state` | model health + key rotation snapshot |
| POST | `/v1/chat/completions` | OpenAI body; `model` = ladder name (default `deepseek`); `stream: true` → SSE; `tools` passed through |

Extra optional body fields: `ladder_timeout_ms` (per rung, default 20000),
`ladder_ttfb_ms` (streaming: first-token window, default 15000), `ladder_total_timeout_ms` (whole
ladder), `ladder_rung` (benchmarks: pin one rung of the ladder — no failover; used by the
continuous bench in trained-assist-free-models-benchmark). Streaming picks the rung before the first output token (text, reasoning or tool call);
after it there is no failover.

opencode provider (free ladder): `baseURL = https://llm-ladder.trainedassist.store/v1`,
`apiKey = <LADDER_TOKEN>`, model `free-ladder`. Response = the upstream `chat.completion` with `model`
set to the rung that answered, plus headers `x-ladder-model` / `x-ladder-attempts`.
Failure: `502 {error:{type:"ladder_error", attempts:[…]}}`.

```bash
curl -s https://llm-ladder.trainedassist.store/v1/chat/completions \
  -H "Authorization: Bearer $LADDER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"model":"deepseek","messages":[{"role":"user","content":"Верни JSON {\"ok\":true}"}],"response_format":{"type":"json_object"}}'
```

Clients:

- `trained-assist-agent` `src/service-llm.js` — all small service calls (`deepseek`); the only
  implementation, no in-process copy.
- `pr-autofix` ≥ v1.6.0 — every stage (`free-ladder`), token via org secret `LLM_LADDER_TOKEN`.
- opencode — provider `baseURL=https://llm-ladder.trainedassist.store/v1`, model `free-ladder`.

## Development

```bash
npm test            # node:test — ladder + state logic (no Workers runtime needed)
npx wrangler dev    # local worker
```

Secrets (`wrangler secret put`): `LADDER_TOKEN`, `OPENCODE_GO_API_KEYS`, `OPENROUTER_API_KEY`.
Deploy: push to `main` → CI runs tests → `wrangler deploy` (GitHub secrets `CF_API_TOKEN`,
`CF_ACCOUNT_ID`).

Inspecting what actually served a call (which rung, which key, which error): the worker logs one
JSON line per call with the full `attempts` array. Dispatch the `query-ladder-logs` GitHub Actions
workflow (inputs `hours`, `step_min`, `needle`, `regex_hours`) to query Workers Observability and
print the aggregation — served-model histogram, distinct error strings, `key-rotated` / `key-probe`
events, OpenRouter descents. Live health + key rotation snapshot: `GET /v1/state`.

Per-call trace log (who burned the tokens): every call is appended to D1 `ladder_calls` with the
caller's `x-ladder-trace/run/user/chat/session` ids. Dispatch the `query-ladder-trace` workflow
(`preset` = `recent` | `trace` | `user` | `chat` | `session` + `value` | `summary` | `sql` with a
read-only SELECT; `hours`, `limit`) — e.g. `gh workflow run query-ladder-trace -f preset=summary`.

Spend & reliability digest: `scripts/analytics.py` rolls the D1 trace into a markdown report —
calls/ok-rate/latency per ladder, served rungs with tokens, estimated OpenRouter spend
(tokens × current list price from the public `/models` endpoint; Go rungs are subscription → no
cost, `:free` → $0), failover-depth histogram and digit-normalized top errors. The
`ladder-analytics` workflow runs it daily (and on dispatch, inputs `days`, `format`) into the job
summary; locally: `CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… python3 scripts/analytics.py
--days 7 [--format json]`. Stream calls still report no usage (#22), so spend is a lower bound.

## Claude Code Instructions

- Keep the Worker dependency-free; logic stays in pure modules (`src/ladder.js`, `src/state.js`)
  so node:test covers it — `src/index.js` / `src/state-do.js` are thin runtime adapters.
- Changing the ladder = edit `config/ladders.json` + the test that pins the order, and log it in
  `docs/requirements-log.md`.
- Never add a rung that is more expensive than the ones above it without the owner's decision.
- PRs only, never push to `main` directly.
