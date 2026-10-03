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
| `build` | base: space-bunny-free → longcat → ling-sante:free → paid tail. **No mimo.** |
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

## How a call resolves

1. POST `/v1/chat/completions`, `model` = ladder name (`service` default).
2. Model **health**: a failing rung is skipped for everyone (per-model backoff 15s → 30s → … cap 5 min; quota/limit errors use their classified TTL).
3. **Go key rotation**: a key-level fault (weekly limit, 429, rejected key) rotates to the next pool key and retries the *same* rung; a non-key fault gets one spare-key probe.
4. **Guard**: empty content, or non-JSON when `response_format: json_object`, fails the rung.
5. Walk down until one answers → that model's completion is returned (`model` field names the winner).

---

## API

All endpoints except `/health` need `Authorization: Bearer <LADDER_TOKEN>`.

| Method | Path | |
|---|---|---|
| GET | `/health` | liveness + ladder names |
| GET | `/v1/models` | ladders as model ids (`service`, `service:gate`, `vision`, …) |
| GET | `/v1/state` | model health + key-rotation snapshot |
| GET | `/v1/go-usage` | remaining Go allowance per pool key (rolling/weekly/monthly % + reset) |
| GET | `/v1/analytics?hours=N` | per-ladder × model rungs with fresh/cached/output tokens + `cost_usd`, hourly cut, **per-sub-task (`apps`) cut**, failover depth, top errors |
| GET | `/v1/calls` | per-call trace with the rung walk (filter by trace/user/chat/session) |
| POST | `/v1/chat/completions` | OpenAI body; `model` = ladder; `stream:true` → SSE; `tools` passed through |
| POST | `/v1/state/reset-keys` | unpark all Go keys (after replacing the pool) |

Optional body fields: `ladder_timeout_ms` (per rung, 20000), `ladder_ttfb_ms` (stream first-token window, 15000), `ladder_total_timeout_ms` (whole ladder), `ladder_rung` (pin one rung, no failover), `ladder_conversation` (sticky-rung key).

OpenRouter attribution: send `x-ladder-app: <slug>` and `x-ladder-app-title` — the worker adds `HTTP-Referer`, `X-OpenRouter-Title`, `X-OpenRouter-App-Visibility` on `openrouter/*` rungs only.

`x-ladder-app` is also **stored** on the trace row (migration `0004_app.sql`) and is the
discriminator for the `apps` cut in `/v1/analytics`: it is the only thing that tells apart the
~20 service sub-tasks, since all of them post `model: "service"`. Send the concrete tool/task
name (`gtd-intent`, `tg-format`, `session-summary`, `failure-classifier`, …) — the agent
already sends it as its `source:` value, and the worker stores the same sanitised slug it
sends to OpenRouter, so the two views can never disagree. Rows with no header are skipped by
the cut; the ladder name stays the coarse view.

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
npm test              # ladder + state + analytics (node:test, no runtime needed)
npm run gate          # live gate: one pinned call per gate rung against prod
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
- Zen free rungs live in the `free` tail only — never ahead of a working free rung.
