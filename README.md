# trained-assist-llm-ladder

OpenAI-compatible **model ladder**: one HTTP endpoint that walks a named list of models
(rungs) top-down and answers from the first one that works. Small "service" LLM calls across
trained-assist repos — answer buttons, formatting, classifiers, summaries, routing — plus the
interactive agent roles (build/plan/explore/review).

Cloudflare Worker + one Durable Object. No VM.

Live: `https://llm-ladder.trainedassist.store`

---

## The one rule

**One ladder = one canonical name. No aliases.** Every name below is final; the config has an
empty `aliases` object. A request that names a ladder which doesn't exist gets
`404 unknown ladder: <name>` — loud, not silent.

Rung providers:

| prefix | what it is |
|---|---|
| `opencode-go/*` | OpenCode Go subscription (per-model monthly $ limits, key rotation) |
| `openrouter/*` | OpenRouter pay-per-token — `:free` models are $0 |
| `opencode-zen/*` | Zen free tier, proxied through the GCP relay (`scripts/zen-relay.mjs`) |
| `zen-rings/*` | Zen free tier through the **ring of GitHub Actions repos** — called in-process, same worker, no token |

---

## Ladders

`config/ladders.json` is the source of truth. Thirteen ladders, three groups.

### 1. Service calls (`service`) — the default

The `service` ladder answers small mechanical calls: buttons, paragraph formatting,
classifiers, summaries, routing. It has **no role suffix by default** — callers post
`{"model": "service"}`.

Roles (opt in with `"model": "service:<role>"`) split by what the call *is*, so each can be
benchmarked and priced separately:

| role | for | policy |
|---|---|---|
| `build` (default) | generic service call | Pareto-first: mimo → free ×8 → zen ×4 → paid tail |
| `classify` | classify, failure-classifier, plan-detect, menu-detect, gtd-intent | free-first (short, cheap) |
| `summarize` | session-summary, session-digest | mimo → free |
| `format` | tg-format, content-rewrite, answer-glyph-guard | free-first (mechanical) |
| `route` | quick, workrun, quick-answer-verify | mimo → free |
| `gate` | issue-fixer-gate, playbook-validator | mimo → free → paid tail (reliability) |

`service:plan|explore|general|review` exist too (used by the opencode agent roles, same rungs as
`build`).

### 2. Role ladders (interactive agent work)

Each role is its own ladder. `explore` is big-context (≥1M on every rung); the rest are
advanced-first (mimo → paid tail).

| ladder | shape |
|---|---|
| `build` | **zen pool ×2** (`mimo-v2.6-flash-free` → `nemotron-3.5-lightning-free`) → space-bunny-free → longcat → ling-sante:free → paid tail. **No mimo.** |
| `build advanced` | mimo → paid tail |
| `plan` / `general` / `review` | mimo → paid tail |
| `explore` | mimo (1M) → gemini-2.5-flash-lite (1048576) → xiaomi/mimo (1050000) — contexts measured on OpenRouter 2026-10-02 |
| `vision` / `vision advanced` | gemini stack for multimodal image+text |

There is **no escalation between levels**: a ladder retries down its own rungs; moving
`build` → `build advanced` is the caller's call (an opencode profile, `ladder_rung`).

### 3. Free ceiling + specialist ladders

| ladder | shape |
|---|---|
| `free` | hard **$0**: space-bunny-free → longcat → OR `:free` ×6 → zen ×4. Never spends money. |
| `conversation` | candidate-message writing (hh-skill): gemini-3.1-flash-lite-preview → gemini-2.5-flash → mimo |
| `doctor` | strongest Go tier for playbook doctor steps: mimo → qwen3.7-plus → deepseek-v4-pro → paid xiaomi |
| `research` | hermes/researcher reads: mimo → deepseek-v4.1 → paid gemini-2.5-flash-lite (explore) |

---

## opencode profiles (the assembly)

A profile is **not** a single ladder — it is a **per-role ladder mapping**, one
`~/.config/opencode/profiles/<name>.json` that sets the model for each opencode agent
(`build` / `plan` / `explore` / `general` / `review`):

| profile | build | plan | explore | general | review |
|---|---|---|---|---|---|
| **`master`** | `ladder/build` | `ladder/plan` | `ladder/explore` | `ladder/general` | `ladder/review` |
| **`phd`** | `ladder/build advanced` | `ladder/plan` | `ladder/explore` | `ladder/general` | `ladder/review` |
| **`free`** | `ladder/free` | `ladder/plan` | `ladder/explore` | `ladder/general` | `ladder/review` |
| `ladder-research` | `ladder/research` | `ladder/research:plan` | `ladder/research:explore` | `ladder/research:general` | `ladder/research:review` |

`master` is the default assembly: the **base** build ladder + each role's own ladder.
`phd` swaps build to the advanced tier. `free` puts build on the $0 ceiling. The role ladders
(`build`, `plan`, `explore`, `general`, `review`) are the ones the assembly points at — **not**
the `service` ladder (which is for small mechanical service calls, a separate concern).

The ladder worker does **not** choose a profile — the caller (opencode, the agent's runner)
does. Every ladder name a profile points at must exist; there are no aliases, so a rename
breaks the profile loudly (404) unless the profile is updated too.

---

## How a call resolves

1. POST `/v1/chat/completions`, `model` = ladder name (`service` default).
2. Model **health**: a failing rung is skipped for everyone (per-model backoff 15s → 30s → … cap 5 min; quota/limit errors use their classified TTL).
3. **Go key rotation**: a key-level fault (weekly limit, 429, rejected key) rotates to the next pool key and retries the *same* rung; a non-key fault gets one spare-key probe.
4. **Guard**: empty content, or non-JSON when `response_format: json_object`, fails the rung.
5. Walk down until one answers → that model's completion is returned (`model` field names the winner).

---

## API

All endpoints except `/health` need `Authorization: Bearer <LADDER_TOKEN>`.
During a controlled key rotation, the Worker may temporarily accept one
`LADDER_TOKEN_PREVIOUS` credential. Remove that binding after clients have moved
to the new `LADDER_TOKEN`; do not leave a retired credential active indefinitely.
For independently issued client credentials, `LADDER_TOKENS` may contain a
comma-separated list of additional bearer tokens. Existing `LADDER_TOKEN` and
`LADDER_TOKEN_PREVIOUS` remain valid while additional tokens are added or rotated.
Store each issued value in the consumer's secret store; never expose this list through
an API response or logs.

| Method | Path | |
|---|---|---|
| GET | `/health` | liveness + ladder names |
| GET | `/v1/models` | ladders as model ids (`service`, `service:gate`, `vision`, …) |
| GET | `/v1/state` | model health + key-rotation snapshot |
| GET | `/v1/go-usage` | remaining Go allowance per pool key (rolling/weekly/monthly % + reset) |
| GET | `/v1/analytics?hours=N` | per-ladder × model rungs with fresh/cached/output tokens + `cost_usd`, hourly cut, **per-sub-task (`apps`) cut** + `no_app` coverage, per-model latency/context percentiles + source split (`models`/`sources`), failover depth, top errors |
| GET | `/v1/calls` | per-call trace with the rung walk (filter by trace/user/chat/session) |
| GET | `/v1/free-models?provider=&available=0\|1` | the free-model inventory (D1 `free_models`) with context/price + last probe |
| POST | `/v1/chat/completions` | OpenAI body; `model` = ladder; `stream:true` → SSE; `tools` passed through |
| POST | `/v1/free-models/collect` | one collection pass + diff report; body `{probe, probe_limit, probe_concurrency, dry_run}` |
| POST | `/v1/state/reset-keys` | unpark all Go keys (after replacing the pool) |

Optional body fields: `ladder_timeout_ms` (per rung, 20000), `ladder_ttfb_ms` (stream first-token window, 15000), `ladder_total_timeout_ms` (whole ladder), `ladder_rung` (pin one rung, no failover), `ladder_conversation` (sticky-rung key).

OpenRouter attribution: send `x-ladder-app: <slug>` and `x-ladder-app-title` — the worker adds `HTTP-Referer`, `X-OpenRouter-Title`, `X-OpenRouter-App-Visibility` on `openrouter/*` rungs only.

`x-ladder-app` is also **stored** on the trace row (migration `0005_app.sql`) and is the
discriminator for the `apps` cut in `/v1/analytics`: it is the only thing that tells apart the
~20 service sub-tasks, since all of them post `model: "service"`. Send the concrete tool/task
name (`gtd-intent`, `tg-format`, `session-summary`, `failure-classifier`, …) — the agent
already sends it as its `source:` value.

A headerless call stores **`app = null`, never the router's own name** (#136). The two
destinations want different answers for "no app", and conflating them made unattributed traffic
file itself as the largest application in the cut:

| | OpenRouter `HTTP-Referer` | `ladder_calls.app` |
|---|---|---|
| no header | `…/app/llm-ladder` — upstream needs a name, and there the request honestly *is* the generic proxy | `null` — no caller ever sends `llm-ladder`, so writing it here invents an application |
| valid slug | `…/app/<slug>` | `<slug>` |
| garbage | `…/app/llm-ladder` (never half-repaired, #33) | `null` |

Both sides run the same regex, so a row and the OpenRouter view of one call can never name it
differently — they differ only in the fallback. `/v1/analytics` reports the unattributed
served calls as `no_app.calls` alongside the `apps` cut, so coverage stays visible instead of
the block silently shrinking; the ladder name remains the coarse view for rows with no header.

---

## Clients

Every client sends the **canonical** ladder name:

| client | ladder |
|---|---|
| `trained-assist-agent` `src/service-llm.js` | `service` (+ `service:<role>` per call type) |
| `trained-assist-agent` `src/opencode-ladder-provider.js` | maps opencode profile → `service` / `doctor` / `free` / `research` |
| `pr-autofix` | `free` |
| `trained-assist-hh-skill` | `conversation`, `free`, `service` |
| opencode (agent roles) | `ladder/<role>`: build, build advanced, plan, explore, general, review |

**Contract guard** — before renaming or removing a ladder, run:

```bash
node scripts/check-client-contracts.mjs ~/.config/opencode/opencode.json <vm opencode.json> <agent provider>
```

It extracts every ladder id the clients actually send and fails if any doesn't resolve — a
rename breaks CI, not prod.

---

## Free-model inventory

Every free model the ladder's providers publish, kept in one D1 table (`free_models`, in the
trace DB) and refreshed by GitHub Actions every 4h (`.github/workflows/collect-free-models.yml`).

- **Catalogs** — OpenRouter (`:free` / both prices 0), zen (`*-free` + `big-pickle`), Go
  (`*-free`). A provider that fails to answer is reported as degraded and its models are left
  alone: an outage must not look like "every model left".
- **Row** — `(provider, model_id, name, context, price_in, price_out, price_cached, owned_by,
  description, in_ladder, first_seen, last_seen, available, probe_status, probed_at)`. `model_id`
  is the full ladder rung id, so a row joins to `config/prices.json` / `config/contexts.json`
  directly. Prices are per 1M tokens, like `config/prices.json`.
- **Probe** — one light request per model per run (`max_tokens: 8`, prompt `ping`), budgeted by
  `probe_limit` (default 12) and aimed at the least-recently-probed models first, so a small
  budget still rotates coverage. `probe_status`: `ok` / `limited` (429) / `not_found` /
  `http_<n>` / `error` / `skipped`. zen needs the opencode-client fingerprint and `stream:true`
  (issue #106); Go needs a session header; both are in `src/free-models.js`.
- **Reconcile** — upsert on `(provider, model_id)`, `first_seen` preserved, `last_seen` bumped,
  `available=0` for what disappeared (never deleted — the history is the point).
- **Diff** — `appeared` / `gone` / `changed` (context, price, name, owned_by) between this run
  and the table as it was. That diff is the trigger signal for the free-models benchmark step.

```bash
npm run collect        # one pass against prod, markdown diff on stdout
```

The Go catalog is fetched inside the worker with the `OPENCODE_GO_API_KEYS` pool — the key never
leaves the worker and is never logged. `GET /v1/free-models` reads the inventory back.

---

## Go keys (subscription)

Keys live only in the worker secret `OPENCODE_GO_API_KEYS` (comma-separated pool); clients
never see them. Docs: `docs/go-key-management.md`.

- A weekly-limit key is parked ~6h, then the ladder rotates back automatically.
- Free Go rungs (`*-free`) rotate keys round-robin so no single account is hammered.
- Remaining allowance per key: `GET /v1/go-usage` (or `node scripts/go-usage.mjs`). Free-tier
  limits: `docs/free-tier-limits.md`.

---

## Development

```bash
npm test              # ladder + state + analytics + free-models inventory (node:test, no runtime)
npm run gate          # live gate: one pinned call per gate rung against prod
npm run collect       # one free-model collection pass against prod, markdown diff on stdout
npx wrangler dev      # local worker (cp .dev.vars.example .dev.vars first)
```

Local iteration: `cp .dev.vars.example .dev.vars` (gitignored), `npm run dev`, point clients at
`http://localhost:8787` (or `LADDER_BASE=http://localhost:8787 npm run gate`).

Live gate token from `$LADDER_TOKEN` or `~/.llm-ladder-token` (chmod 600, outside the repo) —
read it only inside the script, never echo it into a prompt or a file in the repo.

---

## Rules for changing the ladder

- Editing `config/ladders.json` means editing the **order of models**, not the router code.
- Don't add a rung more expensive than the ones above it without the owner's decision.
- Changing a ladder *name* is a breaking change: update every client, then run the contract
  guard.
- Zen free rungs live in the `free` tail only — never ahead of a working free rung. The one
  exception is `zen-rings/*`: it is a route, not a price (the models are $0), and the owner put it
  at the head of every text ladder on 2026-10-06 — `nemotron-3-ultra-free` → `mimo-v2.6-flash-free`.
  `vision` / `vision advanced` are excluded: the rung is text-only and cannot serve an image.

---

## Zen Ring (zen-rings rungs)

A GitHub-hosted runner has no inbound address, so "one Actions dispatch per answer" pays a full
cold start every call. The ring instead keeps **one long-lived job** registered with the worker;
a call is a queue push plus the caller's own watchdog, and the answer comes back in the same
request (measured 2.7–2.9 s warm, 10–13 s for a cold boot).

It lives in **this same worker**, so a `zen-rings/*` rung calls the dispatcher **in-process**
(`ringInvoke` in `src/zen-ring.js`) — no token, no second hop, no egress hop. The full OpenAI
request travels with the task (`messages` + `tools`), the runner calls zen with the same
fingerprint the relay uses, and the answer comes back as `tool_calls` / `usage` /
`finish_reason`. A streaming caller gets a synthesised SSE stream (the job answers in one blob).

**Naming — what was renamed and what deliberately was not.** The term `zen-pool` is gone from the
ladder's own surface: the rung prefix is `zen-rings/*`, the module is `src/zen-ring.js`, the
exports are `ringInvoke` / `ringBoot` / `ringCooldown` / `ringWaitForTask` / `scaleRing`. Three
things still say `pool` because they are a protocol shared with the 8 ring repos, and renaming
them here without re-provisioning every repo would break the ring:

| frozen | why |
|---|---|
| HTTP paths `/zen/pool/register\|pull\|result\|stop\|invoke\|metrics\|scale\|health` | the job-side and ops routes the provisioned worker calls |
| `repository_dispatch` type `zen-pool` | each ring repo's workflow declares `types: [zen-pool]` |
| `.github/workflows/zen-pool*.yml`, `scripts/zen-pool*.mjs` | these are the files `zen-ring-sync` copies into every ring repo |

The dispatcher is deliberately a self-contained module (`src/zen-ring.js`): the owner's direction
is that this logic lives in a repository of its own, so moving it out should be a file move, not a
rewrite. That repository is **not** named anywhere in this codebase — `zen-ring-sync` reads the
source of the provisioned worker code from the deploy-time variable
`ZEN_RING_SOURCE_REPO` (branch `ZEN_RING_SOURCE_REF`, default `main`), falling back to this
repository itself. Pointing the worker code at another repository is therefore a variable change
at deploy, not a code change here.

`ZEN_RUNNER_TOKEN` still guards the *ops and job-side* routes (`/zen/pool/register|pull|result|stop`,
`/zen/models`, `/zen/run`, …) — it is never needed by the ladder itself.

### The contract (frozen — do not rework)

**Request** — `POST /zen/pool/invoke` with `Authorization: Bearer <ZEN_RUNNER_TOKEN>`, or
in-process from the ladder (`poolInvoke`, no token):

```json
{ "model": "mimo-v2.6-flash-free",          // required, explicit id — the pool never picks one
  "messages": [ {"role":"system","content":"…"}, {"role":"user","content":"…"} ],
  "tools": [ {"type":"function","function":{"name":"shell","parameters":{…}}} ],
  "max_tokens": 8192,                     // optional, 1..32768, default 300
  "wait_ms": 20000 }                      // optional, 1000..90000, default 30000 — the CALLER's watchdog
```

`messages` is the full OpenAI array (system + history + tools) — that is what the ladder sends.
`prompt` is the legacy one-line fallback, kept for the CLI and older callers.

**200 — the answer:**

```json
{ "task_id": "m5x7-1a2b3c4d", "model": "mimo-v2.6-flash-free", "ok": true,
  "text": "…",
  "tool_calls": [ {"id":"call_1","type":"function","function":{"name":"shell","arguments":"{}"}} ],
  "usage": {"prompt_tokens":123,"completion_tokens":45},
  "finish_reason": "tool_calls",
  "provider_ms": 2100, "served_ms": 2300, "worker_id": "repo:run:attempt", "wait_ms": 20000,
  "cold_start": {"scaled":"queue_not_empty","dispatched":["repo"],"boot_ms":25000} }
```

`cold_start` is present only when the call itself booted the worker.

**Errors** — every non-200 carries `{"error": "…", …}`:

| status | meaning | what the ladder does |
|---|---|---|
| `400` | no model, or neither `messages` nor `prompt` | rung fails (config) |
| `401` | bad `ZEN_RUNNER_TOKEN` (HTTP route only) | ops only |
| `404` / `409` | unknown `task_id` / task not claimed | ops only |
| `413` | body over 8 KB (HTTP route only) | — |
| `429` | budget exhausted (50/min, 500/day per repo+model) | **no retry** — straight down |
| `502` | the runner reported a provider failure (`kind` names it) | one retry, then down |
| `503` | no warm runner and nothing to boot with (`scaled`, `hint`) | one retry, then down |
| `504` | watchdog fired; `task_id` — the job is still working | wait for **that** task, never start a second |

The ladder turns a 200 into a normal OpenAI completion, or a synthesised SSE stream when the caller
asked to stream. A pool error message deliberately contains no `429`/`503` digits, so the error
classifier reads it as a short transient backoff instead of a long quota skip.

**Tools are slimmed before they leave the worker.** The opencode agent ships a ~240 KB tool set;
zen answers `200` with an *empty* body to anything much past a few tens of KB of tools. The worker
therefore truncates every tool's `description` (and each parameter's) to 240 characters before
calling zen — the schema is what the model matches on, the prose is not needed. That takes the set
from ~241 KB to ~40 KB.

### Idle = no GitHub Actions

Nothing runs while there is no work. A worker exits itself after `idle_exit_ms` (default 10 min)
and the autoscaler only boots one when a call actually arrives — the first request of a cold ring
pays the ~10–13 s boot, every later one is served by the warm job. The 2-min scale cron reads
`metrics` and dispatches nothing when the queue is empty.

- Ring routes + autoscaler + budget: `docs/zen-runner.md`.
- Local client: `npm run zen -- <health|pool|models|metrics|scale|call|result>` (`scripts/zen-pool-client.mjs`).
- A cold ring is not an error: the call boots a worker and the caller's watchdog covers the boot.
