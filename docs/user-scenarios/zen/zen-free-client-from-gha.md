# Zen free client from GitHub Actions

Epic: [#95](https://github.com/trained-assist/trained-assist-llm-ladder/issues/95) ·
Research: [#106](https://github.com/trained-assist/trained-assist-llm-ladder/issues/106) ·
Spec: [`docs/github-actions-zen-client-spec.md`](../../github-actions-zen-client-spec.md) ·
status: planned · 2026-10-04

## Value

**Actor:** the owner of a GitHub Actions job that wants free LLM compute (probe, benchmark,
batch classification) — today `scripts/zen-limit-probe.mjs` fires raw requests — and the person
reading that job's report the next morning.

**Result:** a job can call zen free models **and know whether the answer came from the model or
from the limit**. A finished job says «4/4 answered» or «stopped at request 800: local budget» or
«⛔ not measured: daily quota until 00:00 UTC» — never a silent `0/6` that reads like a broken
model. Negative value closed at the same time: one runner tripping a quota can no longer look like
a model outage, and a job that was going to be throttled by a quota stops *before* the throttling
instead of after it.

**Evidence level: V4** — the owner's own request (04.10, «тестовая сборка на GitHub Actions …
проверь что работают и вызываются модели из Дзен») on top of a documented incident
[#86](https://github.com/trained-assist/trained-assist-llm-ladder/issues/86): zen 429 knocked the
whole ladder onto the **paid** OpenRouter tail, i.e. the blind spot between «limit» and «model is
bad» has already cost money. Research #106 measured the limits; the probe script has been firing
unguarded requests against them ever since.

## Functional blocks

| block | what it is |
|---|---|
| `scripts/zen-client.mjs` → `createZenClient().chat()` | the client: fingerprint, SSE aggregation, per-model rate window, daily budget, 429 classification, cooldown, pre-flight context check |
| `scripts/zen-client.mjs` → `state()` / `summary()` | machine-readable outcome for a step summary / report artifact |
| `.github/workflows/zen-selftest.yml` → job `selftest` | the test build: one live call per free model, one negative fingerprint call, offline context check, report |
| `test/zen-client.test.js` | offline unit tests (`node --test`) for the parts that must not need the network |

Existing and reused, not rebuilt: `scripts/zen-limit-probe.mjs` (limit research, `--omit`
matrix, `--fill-tokens` cap measurement), `scripts/zen-relay.mjs:104` (`aggregateSse` — the SSE
fold this client copies), `docs/free-tier-limits.md` (the measured limit table).

## Steps (EARS)

1. **Signed call.** WHEN a job calls `chat({model, messages})` for a zen **free** model THEN the
   client sends the full opencode fingerprint (`user-agent: opencode/…`, `x-opencode-session:
   ses_<12 hex><14 alnum>`, body `stream: true`, tools containing both `shell` and `read`) and the
   answer arrives as ONE `chat.completion` — the upstream SSE folded back, `usage` preserved —
   with `ok: true, message, usage, finish_reason, ms`.
2. **Rate governor.** WHEN the job fires many calls at one model THEN at most `ratePerMin` (default
   80) of them start in any sliding 60 s window **for that model**, and a model over its window
   waits — a second model keeps its own window and is not slowed by the first.
3. **Daily budget.** WHEN a run has already made `dailyBudget` (default 800) calls **on that model**
   THEN the next `chat()` returns `{ok: false, kind: 'cooldown', stoppedBy: 'local-budget'}` without
   a network call; other models continue on their own budget.
4. **Remote daily quota.** WHEN zen answers 429 **with** `retry-after` THEN the result is
   `kind: 'daily'`, `retryAfterSec` is recorded and `cooldownUntil = now + retryAfterSec`, and every
   later `chat()` on that model short-circuits with `kind: 'cooldown'` until that moment — no
   requests while it is in the future.
5. **Remote rate / provider quota.** WHEN zen answers 429 **without** `retry-after` THEN the kind is
   `provider` if the body carries `Error from provider (Console)` and `rate` otherwise, and
   `cooldownUntil = now + providerCooldownMs` (default 60 min).
6. **Broken signature is loud.** WHEN zen answers **403** THEN the result is
   `kind: 'fingerprint'` — no cooldown, and the job exits non-zero, because a 403 is a regression in
   our headers, never a limit.
7. **Server error is not a limit.** WHEN zen answers 5xx or the request times out THEN the result is
   `kind: 'error'` / `kind: 'timeout'` with `retryable: true`, the quota is left untouched, and the
   job's own backoff decides.
8. **Context checked before the network.** WHEN `prompt + max_tokens` exceeds the model's cap from
   the client's cap table THEN the request is **not sent**: the result is
   `{ok: false, kind: 'context', cap, input, maxTokens, over}` with no cooldown and no call counted;
   with `truncate: true` the client instead drops the oldest non-`system` messages until it fits and
   reports that it did.
9. **Unstable cap is promised as the floor.** WHEN the model is `big-pickle` (backends disagree:
   262 139 and ≥1M) THEN `contextCap('big-pickle')` is **262 139**, never 1M — a cap that may not
   hold is not a promise. A model missing from the table is `unknown: true` and the server decides.
10. **Honest report.** WHEN the run ends — for any reason — THEN `summary()` gives, **per model**,
    `calls, ok, limited, stoppedBy, cooldownUntil`, and the step summary prints
    `cooldownUntil` as an ISO UTC instant and `lastRetryAfterSec` when there was one; a rate-limited
    cell is marked ⛔ «not measured» and is **excluded from the denominator** of any quality number.
11. **State survives a fixed egress.** WHEN the client is given a `state` (loaded from a file at the
    start of a run) THEN the counters and `cooldownUntil` continue from that file and are written
    back at the end, split by model, with the UTC day as the reset boundary — so a self-hosted
    runner sharing an IP with production cannot quietly spend production's quota.
12. **The test build proves it.** WHEN `zen-selftest.yml` is dispatched (or scheduled) THEN each
    free model gets one live signed call, the result lands in the job summary as ok / ⛔ / error, and
    the job fails **only** on `kind: 'fingerprint'` or an unexpected non-200 — a quota stop is a
    green-with-a-story outcome, not a red X.

## Acceptance (from spec §12, made checkable)

- One signed call per free model returns 200 (live, from the runner).
- The same call with `stream: false` returns **403** and the client reports `kind: 'fingerprint'`.
- `dailyBudget: 5` → the 6th call is `{ok:false, kind:'cooldown', stoppedBy:'local-budget'}` and no
  request leaves the process.
- `ratePerMin: 80` → the peak of the sliding window in the log never exceeds 80.
- A 300K-token prompt for `big-pickle` (cap 262 139) → `{ok:false, kind:'context', cap:262139}` with
  **no** network call; the same prompt for `mimo-v2.6-flash-free` (cap 1 048 576) goes out and is
  answered.
- `contextCap('big-pickle') === 262139` even though some of its backends accept ≥1M.
- Tripping one model to 429 does not silence another model from the same IP (§12.11) — checked by
  the probe's `--model-after`, not by burning a real quota in the test build.
- The report marks limited cells ⛔ and `stoppedBy` is filled; the quality denominator excludes them.

## Non-goals

- Not a replacement for `scripts/zen-limit-probe.mjs`: the probe deliberately fires **unguarded**
  requests to *measure* limits; the client deliberately avoids them. They share the fingerprint, not
  the purpose.
- Not a change to the ladder Worker (`src/`), to `config/ladders.json`, or to the `opencode-zen/*`
  relay path — the Worker reaches zen through `scripts/zen-relay.mjs`, and this client is for jobs
  that talk to zen **directly**.
- No paid fallback and no key handling: the free tier is anonymous (`Bearer public`), and there are
  no credentials in this client by design (R9).
- Not measuring caps for models outside the table — that stays `--fill-tokens` in the probe, and the
  measured value is then written into the table by hand.
- No fan-out orchestration: the matrix in the workflow is GitHub's, not the client's.

## Edge cases

- Unknown model (not in the cap table) → context check passes through as `unknown`, the server's
  `400` is classified as `error`, not as `context`.
- Model removed from `/v1/models` between runs → zen answers 404/400; classified `error`, the job
  reports the model by name rather than as a quota.
- `stream_options.include_usage` missing in the reply → `usage` is `null`, not a crash; the report
  shows calls without token counts.
- SSE stream that ends mid-tool-call → `aggregateSse` returns the partial function arguments it
  has; `finish_reason` falls back to `stop`/`tool_calls` so a truncated stream is visible.
- `retry-after` that is not a number → treated as absent (`rate`/`provider`), never `NaN` into a
  Date.
- Two jobs on the same self-hosted runner → separate processes, separate windows; they can still
  overrun the shared quota between them, which is why `dailyBudget` on fixed egress is set to a
  share, not to 800.
- Clock skew making a persisted `cooldownUntil` look far in the future → the job waits for it rather
  than firing into a wall; the ISO instant is in the report so a human can see why.

## Open points (decided here, flagged as risk)

1. **New free models are not in the cap table.** The live `/v1/models` list already has
   `deepseek-v4-flash-free`, `nemotron-3-ultra-free`, `ling-3.1-flash-free`, `space-bunny-free`,
   `longcat-2.5-preview-free`, `jev-1.13-free`, `fledge-alpha-free`, `muse-spark-1.3/1.2-contributor-free`,
   none of which were in the spec's table. They run (unknown cap → server decides); their caps are
   **not** measured yet. Risk: a job may hit a `400` on context where a table entry would have
   caught it. Mitigation: the test build lists unknown-cap models explicitly in the summary.
2. **`providerCooldownMs` default 60 min** is below what was observed (>100 min). A job that resumes
   too early burns calls into the same wall. Chosen 60 min because a too-long cooldown silently
   ends a run; the ISO value is reported so the human can override.
3. **`aggregateSse` is duplicated** from `scripts/zen-relay.mjs:104` rather than extracted — the
   client must stay a self-contained module a job can vendor into its own repo. Risk: the two copies
   drift. Mitigation: comment cross-reference in both files; extraction is a separate, later PR.
4. **Concurrency default is left to the job** (spec recommends ≤4). The client governs *rate*, not
   parallelism; a job that fires 50 concurrent calls still occupies 50 sockets.