# trained-assist-llm-ladder

OpenAI-compatible **model ladder** for small "service" LLM calls across trained-assist repos
(answer buttons, formatting, classifiers, summaries, routing). Cloudflare Worker — no VM.

Live: `https://llm-ladder.trainedassist.store`

## Ladders

`config/ladders.json`:

- **`deepseek`** (alias `service`) — small service calls; owner decision 2026-09-27, same for every role:

1. `opencode-go/mimo-v2.6-flash`
2. `opencode-go/deepseek-v4.1-flash`
3. `openrouter/deepseek/deepseek-v4-flash-0731` — paid tail starts here ($0.021/$0.32 per M)
4. `openrouter/inclusionai/ling-3.0-flash` — paid, different vendor (InclusionAI), 2–7s ($0.021/$0.063)
5. `openrouter/xiaomi/mimo-v2.6-flash` — paid, third vendor ($0.14/$0.28)

(`opencode-go/muse-spark-1.3-contributor` was removed 2026-09-27 — owner: broken, drop it.)

- **`doctor`** — strongest tier for playbook `doctor` steps when Claude/Codex are unavailable
  (owner decision 2026-09-28): Go MiMo-V2.6-Flash primary (τ²-bench airline 76.6%, above Kimi K2.7
  Code 71.7%), then *stronger* Go models instead of cheaper ones — `qwen3.8-max` → `qwen3.7-plus` →
  `deepseek-v4-pro` — and paid OpenRouter `xiaomi/mimo-v2.6-flash` last.

- **`free`** (alias `free-ladder`) — cheap/free rungs for agents that run on weak models
  (opencode as a client, pr-autofix): OpenCode Go cheap models first, OpenRouter `:free`
  fallback; order from the pr-autofix bench (2026-09-26). Streaming + tools supported.

Rungs are tried top-down:

- **Model health** — a failing rung is skipped for everyone: transient faults back off per model
  (15s → 30s → 60s … cap 5 min, each model its own counter); quota/limit errors skip for the
  classified TTL (`src/classify.js`).
- **Two OpenCode Go keys** (`OPENCODE_GO_API_KEYS`) — a key-level fault (usage limit, 429,
  rejected key) rotates to the spare key and retries the same rung. When both keys are parked,
  every Go rung is skipped until the earliest key heals (15 min quota / 1 h rejected), so the
  ladder serves OpenRouter and returns to Go by itself. 503 / Bad Request never burn a key.
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

## Claude Code Instructions

- Keep the Worker dependency-free; logic stays in pure modules (`src/ladder.js`, `src/state.js`)
  so node:test covers it — `src/index.js` / `src/state-do.js` are thin runtime adapters.
- Changing the ladder = edit `config/ladders.json` + the test that pins the order, and log it in
  `docs/requirements-log.md`.
- Never add a rung that is more expensive than the ones above it without the owner's decision.
- PRs only, never push to `main` directly.
