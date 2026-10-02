# trained-assist-llm-ladder

OpenAI-compatible **model ladder** for small "service" LLM calls across trained-assist repos
(answer buttons, formatting, classifiers, summaries, routing). Cloudflare Worker — no VM.

Live: `https://llm-ladder.trainedassist.store`

## Ladders

`config/ladders.json`:

- **`service`** (renamed from `deepseek` in issue #49 — the legacy alias `deepseek` keeps
  resolving, so no client changes; the agent keeps sending it) — small service calls; owner
  decision 2026-10-02 (issue #67): **Pareto-first**, same for every role — the best model by
  bench opens, the eight free rungs move into the tail right before the paid one (so a Go
  weekly-limit incident still lands on free before any money is spent, #36 economics kept) —
  a default call no longer opens on a weak free model. Free-first window that #67 closes:
  2026-09-30T15:16Z (#39) → 2026-10-02 (#67 deploy); free rungs first entered the default
  ladder 2026-09-30T11:07Z (#27). Owner 2026-09-30 (issue #42): the four zen rungs live in
  `free` only:

1. `opencode-go/mimo-v2.6-flash` — Go **subscription**, best by Pareto (τ²-bench 76.6%;
   «мимо норм»), the same starting rung as `research` and `doctor`
2. `opencode-go/space-bunny-free` — Go free tier, **Unlimited** (limited time); keeps working
   after the Go usage limit, so a weekly-limit incident stops here
3. `opencode-go/longcat-2.5-preview-free` — Go free tier, Unlimited (limited time), zero-retention
4. `openrouter/nvidia/nemotron-3-super-120b-a12b:free` — OpenRouter free (issue #26)
5. `openrouter/inclusionai/ling-3.0-flash-sante:free` — OpenRouter free, second vendor
6. `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` — OpenRouter free, strongest by bench
   (coding 49.3; flaky some hours — health-skip walks past it)
7. `openrouter/cohere/north-mini-code:free` — OpenRouter free, third vendor
8. `openrouter/dots-studio/dots-3-note-preview:free` — OpenRouter free, fourth vendor
9. `openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` — OpenRouter free, fifth vendor
10. `openrouter/inclusionai/ling-3.0-flash` — paid tail starts here ($0.021/$0.063 per M, live
    OpenRouter price 2026-09-30; fastest paid rung: 1–4s and judge q2 in the continuous bench)
11. `openrouter/xiaomi/mimo-v2.6-flash` — paid, second vendor ($0.14/$0.28; owner: «мимо норм»)

(`opencode-go/muse-spark-1.3-contributor` was removed 2026-09-27 — owner: broken, drop it.)
(`openrouter/deepseek/deepseek-v4-flash-0731` was removed 2026-09-30 — issue #45: the live
OpenRouter price is $0.01/**$1.28** per M output (40× ling), the bench shows ❌ ping/json/code
and a live probe timed out at 60s on code-gen/agent-plan — owner: «дипсик вполне можно
заменять». Alongside it #45 adds ONE same-rung guard-retry for empty/non-JSON answers.)
(`opencode-go/deepseek-v4.1-flash` was dropped from this ladder 2026-10-01 — issue #49: the
intermittent `HTTP 400 {"model":"deepseek-v4.1-flash"}` (×8/hour in query-ladder-logs, known
since 2026-09-25) + bench ❌ on agent-plan/code-fix; owner: «дипсик вполне можно заменять».
It REMAINS in the `research` ladder.)

**Zen free tier needs a relay** and lives in the `free` ladder only (owner decision 2026-09-30,
issue #42). OpenCode gates `zen/v1` free models behind an exact client
fingerprint (captured live: `Bearer public`, `User-Agent: opencode/1.18.31 ai-sdk/…`, `x-opencode-client`,
`x-opencode-project`, `msg_`/`ses_` ids, `stream:true`, and `tools` containing functions named
`shell` + `read`) **and** IP reputation: Cloudflare Worker egress gets a stable
`429 FreeUsageLimitError` from every colo, while the GCP VM answers 200. So the Worker calls
`scripts/zen-relay.mjs` (systemd `zen-relay.service` on the GCP VM, nginx `location /zen/` on
`https://136-65-7-197.sslip.io/zen`) with `OPENCODE_ZEN_RELAY_TOKEN`; the relay injects the
fingerprint, forces `stream:true`, merges `shell`/`read` into `tools` (`tool_choice:"none"` when the
caller sent none) and aggregates SSE → JSON for non-streaming callers.

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
  Zen tail (owner decision 2026-09-30, issue #42) — **хвост до починки релея #42**: 14 working
  rungs, then `opencode-zen/mimo-v2.6-flash-free` → `opencode-zen/mimo-v2.5-free` →
  `opencode-zen/big-pickle` → `opencode-zen/nemotron-3.5-lightning-free`. The relay answers 404
  right now, so zen may not be moved ahead of the working rungs — it would break the main free
  fallback (trained-assist-agent#1899) with four dead steps; revisit the order once the relay is up.

- **`conversations`** — candidate-message writing from trained-assist-hh-skill
  (`src/conversation-generation.js`, owner 2026-10-01): `openrouter/google/gemini-3.1-flash-lite-preview`
  (first: newer and cheaper than `gemini-2.5-flash`, $0.25/$1.50 vs $0.30/$2.50) →
  `openrouter/google/gemini-2.5-flash` → `opencode-go/mimo-v2.6-flash`. Model swaps happen here
  (or per-call via `ladder_rung` for A/B and bench pins); the last N question/answer exchanges
  are recorded JSONL on the hh-skill side for later benching.

- **`build` / `build advanced` / `plan` / `explore` / `general` / `review` / `picture` /
  `picture advanced` / `free_100percent`** — interactive agent work; the role/level model
  (issue #71, owner 2026-10-02): **level = a ladder of its own, no escalation between them** —
  «нет эскалации, это не задача лестницы, задача лестницы — ретраи» (a ladder retries down its
  own rungs; moving between levels is the caller's decision, e.g. an opencode profile).
  - `build` — base: `space-bunny-free` → `longcat-2.5-preview-free` → `ling-3.0-flash-sante:free`
    → paid tail (`ling-3.0-flash` → `xiaomi mimo-v2.6-flash`); **no mimo inside**.
  - `build advanced` — advanced head: `opencode-go/mimo-v2.6-flash` → the same paid tail
    (pin it from a profile for a harder task, e.g. code review).
  - `plan` / `general` / `review` — advanced-first: mimo → paid tail (owner: «все кроме build на mimo»).
  - `explore` — **≥1M context on every rung**: mimo (1M) → `gemini-2.5-flash-lite` (1048576) →
    `xiaomi/mimo-v2.6-flash` (1050000), contexts measured on OpenRouter `/v1/models` 2026-10-02;
    Hermes takes this ladder whole for research reads (tail follows research:explore, #28).
  - `picture` / `picture advanced` — the vision stack, all multimodal image+text with 1M ctx
    (OpenRouter architecture 2026-10-02): `gemini-2.5-flash-lite` ($0.10/$0.40) →
    `gemini-2.5-flash` ($0.30/$2.50); advanced: `gemini-2.5-flash` → `gemini-3.8-flash` ($0.75/$3.75).
  - `free_100percent` — **eight free rungs only, a hard $0 ceiling** — for tests with heavy
    token counts or many repeats, where spending must be impossible.

  **Constructors** (#71): (1) plain LLM callers keep the single-model profiles as-is
  (`service`, `conversations` — role suffixes); (2) opencode launches in the agent get a
  four-ladder assembly (`build`/`plan`/`explore`/`general`) — three ready profiles in
  `~/.config/opencode/profiles/`: `free_100percent` (everything on the $0 ladder), `master`
  (build=base ladder, roles on advanced), `advanced` (build→`build advanced`).
  Vision is no longer taxonomy-only: `picture*` ladders exist; legacy callers still keep
  Gemini in-process (#71).

Rungs are tried top-down:

- **Model health** — a failing rung is skipped for everyone: transient faults back off per model
  (15s → 30s → 60s … cap 5 min, each model its own counter); quota/limit errors skip for the
  classified TTL (`src/classify.js`). Exception: a TRANSIENT skip on a Go or zen rung is capped at 30s
  after its last failure — a short Go wobble must not keep the fleet on the paid OpenRouter tail
  (money + a mid-run prompt-cache reset) for the full backoff. Real limits keep their TTL.
- **OpenCode Go key pool** (`OPENCODE_GO_API_KEYS`, comma-separated, index 0 = default primary;
  three keys since 2026-10-01) — a key-level fault (usage limit, 429,
  rejected key) rotates to the spare key and retries the same rung; a WEEKLY allowance parks that
  key for 6 h (`"limitName":"weekly"`), not the 15-minute rate-limit TTL. A rung that fails for a
  NON-key reason (timeout, empty answer, 500) gets ONE spare-key probe per call before the ladder
  leaves Go for paid OpenRouter — a silently throttled key looks exactly like a slow model, and
  staying on Go costs nothing. Context/config rejections never probe (the key cannot change them).
  When every key is parked, only the PAID Go rungs are skipped until the earliest key heals —
  the free Go rungs (`*-free`) keep serving, they don't eat the allowance (#69) — so the ladder
  rides the incident out on free Go → OpenRouter :free → paid and returns to Go by itself. Every attempt entry carries the pool `key` index
  (`ok` / `error` / `key-rotated` / `key-probe`), so `/v1/state` and the Workers Observability
  logs show which key served. 503 / Bad Request never burn a key.
- **Guard** — empty content, or non-JSON when `response_format: json_object`, fails the rung.
- **`max_tokens` floor** (`src/ladder.js`) — the caller's `max_tokens` is raised to at least
  `MIN_TOKENS = 1500`, and to `REASONING_MIN_TOKENS = 3000` for the rungs of the empirical
  `REASONING_MODELS` list (issue #38, owner decision: variant 2): a reasoning rung can burn the
  whole 1500 floor on chain-of-thought (`empty answer (finish=length, out=1500, reasoning=1500,
  prompt=97, max_tokens=1500)` in prod → content empty → chronic guard failures), so only those
  rungs get the higher floor. The list is measured, not guessed: every rung of
  `config/ladders.json` was pinned through the live worker (`ladder_rung`) and its
  `usage.completion_tokens_details.reasoning_tokens` read — 24 of 26 unique rungs reason,
  including the four zen tail rungs of `free` (measured 2026-09-30 through the relay, #42:
  17/15/255/43 reasoning_tokens); `openrouter/google/gemini-2.5-flash-lite` reads 0 and stays at
  1500, `ling-3.0-flash-fin:free` was a dead rung (no data; removed from the free ladder 2026-09-30 —
  34×404/day in the hourly digest). The #34 guard diagnostic prints the
  floor that actually went upstream.

State lives in one global Durable Object (`LadderState`) — strongly consistent across callers.

> Research / presentation / vision calls are NOT for this service — they stay on Gemini in their
> callers (owner: «gemini для рисеча и для презентаций он прямо гуд»).

## API

All endpoints except `/health` need `Authorization: Bearer <LADDER_TOKEN>`.

| Method | Path | |
|---|---|---|
| GET | `/health` | liveness + ladder names |
| GET | `/v1/models` | ladders as model ids (`service`, `service:review`, …) |
| GET | `/v1/state` | model health + key rotation snapshot |
| GET | `/v1/analytics?hours=N` | aggregates over the D1 trace: per-ladder calls / failures / tokens, attempts-depth histogram and merged top-20 errors (digit-normalized, same grouping as `scripts/analytics.py`); N = window in hours, 1–168, default 24. What the hourly Telegram digest in `vm-telegram-monitor` renders |
| POST | `/v1/chat/completions` | OpenAI body; `model` = ladder name (default `service`, legacy alias `deepseek`); `stream: true` → SSE; `tools` passed through |

Extra optional body fields: `ladder_timeout_ms` (per rung, default 20000),
`ladder_ttfb_ms` (streaming: first-token window, default 15000), `ladder_total_timeout_ms` (whole
ladder), `ladder_rung` (benchmarks: pin one rung of the ladder — no failover; used by the
continuous bench in trained-assist-free-models-benchmark). Streaming picks the rung before the first output token (text, reasoning or tool call);
after it there is no failover.

App attribution to OpenRouter (issue #33): send `x-ladder-app: <slug>` (`[a-z0-9-]`, ≤64 chars,
default `llm-ladder`) and optionally `x-ladder-app-title: <name>` (default `Trained Assist`). For
`openrouter/*` rungs the worker adds `HTTP-Referer: https://recruiter-assistant.ru/app/<slug>` —
the URL *is* the application id in the OpenRouter "Application" analytics cut — plus
`X-OpenRouter-Title` and `X-OpenRouter-App-Visibility: hidden` (hidden from public rankings,
analytics kept). A garbage/absent slug falls back to `llm-ladder`, never a half-repaired one.
`opencode-go/*` rungs get none of these (not an OpenRouter concept there).

opencode provider (free ladder): `baseURL = https://llm-ladder.trainedassist.store/v1`,
`apiKey = <LADDER_TOKEN>`, model `free-ladder`. Response = the upstream `chat.completion` with `model`
set to the rung that answered, plus headers `x-ladder-model` / `x-ladder-attempts`.
Failure: `502 {error:{type:"ladder_error", attempts:[…]}}`.

```bash
curl -s https://llm-ladder.trainedassist.store/v1/chat/completions \
  -H "Authorization: Bearer $LADDER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"model":"service","messages":[{"role":"user","content":"Верни JSON {\"ok\":true}"}],"response_format":{"type":"json_object"}}'
```

Clients:

- `trained-assist-agent` `src/service-llm.js` — all small service calls (sends `deepseek`, the
  legacy alias of `service` — no agent change needed, issue #49); the only implementation, no
  in-process copy.
- `pr-autofix` ≥ v1.6.0 — every stage (`free-ladder`), token via org secret `LLM_LADDER_TOKEN`.
- `trained-assist-hh-skill` `src/conversation-generation.js` — candidate-message writing
  (`conversations` ladder), ATS evaluation (`free-ladder`), funnel planner (`service`); token via
  `LLM_LADDER_TOKEN` / `$AGENT_TOKENS_DIR/llm-ladder/token`.
- opencode — provider `baseURL=https://llm-ladder.trainedassist.store/v1`, model `free-ladder`.

## Pool endpoints

Control-plane tail for the runs pool (owner decision 2026-10-01): the worker relays **metadata and
references only** — a task string ≤ 4000 chars plus optional pointers. Big data (GB) never goes
through this API: payloads move presigned-URL direct between the client and object storage, and
`artifactRef` is just the *reference* — the worker never downloads it, only forwards it in the
dispatch («ГБ всегда presigned-прямым путём»).

| Method | Path | Auth | |
|---|---|---|---|
| POST | `/pool/trigger` | `Bearer $POOL_TRIGGER_TOKEN` (own token, timing-safe compare — not `LADDER_TOKEN`) | body ≤ 8 KB → GitHub `repository_dispatch` → `202 {queued:true, location, reserved?}` |
| GET | `/pool/health` | none | `{service:"pool", ok:true}` |

Nothing else under `/pool/*` exists yet (`status` — later, owner's call).

`POST /pool/trigger` body: `{"task": "<required, ≤4000 chars>", "repo": "owner/name", "profile": "...", "artifactRef": "...", "location": ""}` —
`repo`/`profile`/`artifactRef` are optional plain strings forwarded as-is (unknown body keys are ignored).

`location` (epic ai-agent-run-api#1, Ф1) is an enum: `""` | `ru` | `eu` | `us`. Absent == `""`.
`""` = our pool (runs normally); `ru`/`eu`/`us` are reserved for future regional pools — the dispatch
still goes out (the receiver records `location_reserved` and does not run), and the response carries
`reserved: true`. Anything else → `400` naming the field `location`, before any dispatch.

Responses: `202 {queued:true, location, reserved?}` once GitHub accepts the dispatch (outgoing cap 10 s);
`502 {error:"dispatch_failed", gh_status}` on a non-2xx/timeout (`gh_status: null` on timeout);
`401` missing/wrong bearer; `413` body > 8 KB; `400` validation;
`503 {error:{type:"CONFIG"}}` while a secret is not set.

The dispatch goes to `vovalikessmoothy-png/ai-agent-runs-pool` as
`{event_type: "agent-task", client_payload: {task, repo, profile, artifactRef, location, ts}}`, where
`.github/workflows/agent-task.yml` picks it up. Worker logs carry metadata only — task length and
statuses, never the task text or any token.

Secrets: GCP Secret Manager is the source of truth (`POOL_TRIGGER_TOKEN`,
`GITHUB_AI_AGENT_RUNS_POOL`), mirrored into the worker with `wrangler secret put` — never in git.

```bash
curl -s -X POST https://llm-ladder.trainedassist.store/pool/trigger \
  -H "Authorization: Bearer $POOL_TRIGGER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"task":"smoke","repo":"trained-assist/ai-agent-runner"}'
# → {"queued":true,"location":""}

curl -s -X POST https://llm-ladder.trainedassist.store/pool/trigger \
  -H "Authorization: Bearer $POOL_TRIGGER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"task":"smoke","location":"ru"}'
# → {"queued":true,"location":"ru","reserved":true}   (региональный пул ещё не подключён)

curl -s -X POST https://llm-ladder.trainedassist.store/pool/trigger \
  -H "Authorization: Bearer $POOL_TRIGGER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"task":"smoke","location":"mars"}'
# → 400 {"error":{"message":"location: expected one of \"\", \"ru\", \"eu\", \"us\", got \"mars\"", ...}}

curl -s https://llm-ladder.trainedassist.store/pool/health
# → {"service":"pool","ok":true}
```

## Development

```bash
npm test            # node:test — ladder + state logic (no Workers runtime needed)
npm run test:sandbox  # full route in-process with fake upstreams
npm run gate        # live gate against the running worker (see below)
npx wrangler dev    # local worker
```

Local iteration without touching prod: `cp .dev.vars.example .dev.vars`, fill in real keys, then
`npm run dev` and point clients (or the gate: `LADDER_BASE=http://localhost:8787 npm run gate`) at
`http://localhost:8787`. `.dev.vars` is gitignored — real values never enter the repo.

**Live gate** (`scripts/live-gate.mjs`): `/health` → one `ladder_rung`-pinned call per rung of the
gate ladder (default `service`/`build`; override with `LADDER_GATE_RUNGS="rung1 rung2"`) →
`/v1/state` skip check. A failed pin retries twice (`LADDER_GATE_RETRIES`) — upstream blips don't
flake the gate, a dead rung still does. Token from `$LADDER_TOKEN` or `~/.llm-ladder-token`
(chmod 600, outside the repo) — never printed, never committed. Exit 0 = green. Only people who hold
the token can call the API; repo access (the repo is public) grants nothing.

Secrets (`wrangler secret put`): `LADDER_TOKEN`, `OPENCODE_GO_API_KEYS`, `OPENROUTER_API_KEY`,
`OPENCODE_ZEN_RELAY_TOKEN` (relay shared secret — the Worker sends it as the zen provider key;
without it every `opencode-zen/` rung is filtered out as keyless), plus `POOL_TRIGGER_TOKEN` and
`GITHUB_AI_AGENT_RUNS_POOL` for `/pool/trigger` (both sourced from GCP Secret Manager).
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
The same trace drives the live hourly Telegram digest: `vm-telegram-monitor` polls
`GET /v1/analytics?hours=N` with the ladder token and renders the per-ladder section next to the
OpenRouter spend report.

## Claude Code Instructions

- Keep the Worker dependency-free; logic stays in pure modules (`src/ladder.js`, `src/state.js`)
  so node:test covers it — `src/index.js` / `src/state-do.js` are thin runtime adapters.
- Changing the ladder = edit `config/ladders.json` + the test that pins the order, and log it in
  `docs/requirements-log.md`.
- Never add a rung that is more expensive than the ones above it without the owner's decision.
- Zen free tier runs through `scripts/zen-relay.mjs` on the GCP VM (systemd `zen-relay.service`,
  nginx `location /zen/`). The Worker only holds `OPENCODE_ZEN_RELAY_TOKEN`; the relay owns the
  client fingerprint and the `shell`/`read` tools requirement. Relay down → zen rungs 502 → health
  skip → the ladder walks on; nothing else breaks.
- Live gate = `npm run gate` (`scripts/live-gate.mjs`): health → pinned call per gate rung →
  `/v1/state` skips. Token from `$LADDER_TOKEN` or `~/.llm-ladder-token` (chmod 600, outside the
  repo) — read it only inside the script, never echo it into a prompt, transcript or file in the
  repo. No token → exit 2, not a fake pass. Local loop: `.dev.vars` + `npm run dev` +
  `LADDER_BASE=http://localhost:8787 npm run gate`.
- PRs only, never push to `main` directly.
