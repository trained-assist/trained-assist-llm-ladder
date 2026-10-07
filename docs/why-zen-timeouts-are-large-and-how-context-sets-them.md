# Why zen timeouts are large, and how context sets them

The answer we keep re-deriving, in one place. Read this before touching a timeout or a
context cap — most "why is it 30 seconds?" questions have already been measured.

**The one idea:** a `zen-rings/*` call is not one HTTP request. It is a chain
`caller → ladder → queue → GitHub Actions job → zen`, and every hop costs wall-clock time
independently of the others. The timeout has to cover the *sum*, and the context guards exist
because the fattest inputs are exactly the ones that eat the timeout and then fail anyway.

---

## 1. The chain, and who sets each budget

| hop | constant | value | set by |
|---|---|---|---|
| caller → worker, per rung | `ladder_timeout_ms` | **20 000** default | caller (body field) |
| caller → worker, stream first token | `ladder_ttfb_ms` | **15 000** | caller |
| caller → worker, whole ladder | `ladder_total_timeout_ms` | no default | caller |
| ladder → pool | `wait_ms` | **= the per-rung budget**, clamped to `[1 s, 90 s]` | `attemptRing`, `src/ladder.js:423` |
| pool fallback | `DEFAULT_WAIT_MS` | **30 000** | `src/zen-ring.js:17` |
| pool ceiling | `MAX_WAIT_MS` | **90 000** — «under the edge's idle timeout; longer = poll the result» | `src/zen-ring.js:19` |
| first look at a queued task | `POLL_STEP_MS` | **200** | `src/zen-ring.js:55` |
| one long-poll before re-pulling | `DEFAULT_PULL_HOLD_MS` | **20 000** (range 5 000–25 000) | `src/zen-ring.js:20` |
| dispatch to GitHub | `DISPATCH_TIMEOUT_MS` | **10 000** | `src/zen-ring.js:54` |
| cold-boot window (autoscaler is idempotent inside it) | `BOOT_MS` | **25 000** | `src/zen-ring.js:47` |
| the Actions job itself | `timeout-minutes` | **30** | `.github/workflows/zen-pool.yml` |
| worker → zen | `ZEN_TIMEOUT_MS` | **90 000** default | `scripts/zen-pool-worker.mjs:65` |
| worker → controller | `call(…, 30 000)` | **30 000** | `scripts/zen-pool-worker.mjs:68` |
| worker stops pulling = dead | `LEASE_TTL_MS` | **90 000** | `src/zen-ring.js:24` |
| claimed, no answer = requeue | `ORPHAN_TASK_MS` | **120 000** | `src/zen-ring.js:25` |
| dead queue is reaped after | `STALE_TASK_MS` | **10 min** | `src/zen-runner.js:421` |
| post-504 grace for an answer already in flight | `graceMs` | **15 000** | `ringCall`, `src/ladder.js:392` |

The load-bearing line is `src/ladder.js:420`:

> The caller's per-rung budget **IS** the pool watchdog (clamped to the pool's `[1s, 90s]`).
> A cold pool boots a runner (~10-13 s) and then answers (~3 s), so an interactive caller
> should send `ladder_timeout_ms ≈ 20000`; the default 20000 already covers it.

`MAX_WAIT_MS = 90_000` is not a preference. Past ~90 s the Cloudflare edge drops an idle
connection, so anything longer has to be answered by polling for the result rather than by
holding the request open — which is exactly what the pool does instead of raising the cap.

---

## 2. Why the numbers are large: four independent costs

Nothing here is slack. Each is a separate thing that can take that long on its own.

| cost | measured | source |
|---|---|---|
| **cold boot** of a GitHub Actions worker | **10–13 s** (warm: 2.7–2.9 s) | README, «Zen Ring»; `BOOT_MS` comment |
| **dispatch** to the GitHub API | up to 10 s | `DISPATCH_TIMEOUT_MS` |
| **zen itself** (provider) | normal **4–7 s**; blind/odd calls **19 s and 32.6 s** | `CONTEXT['exo-free']` comment, 20 probes 2026-10-07 |
| **queue + long-poll** | a pull holds up to 20 s before re-polling | `DEFAULT_PULL_HOLD_MS` |

Stack them: a cold call is legitimately `10–13 s boot + ~5 s zen ≈ 15–20 s`, which is why the
default per-rung budget is 20 s and not 2 s.

Live samples from 2026-10-07 (pinned calls through prod): `4.9 s`, `7.3 s`, `8.2 s`, `13.6 s`,
`29.6 s`. The 29.6 s one was a retry after an empty body — a single attempt is rarely the slow
case; *retries and cold boots* are.

Consequences that are already paid for and must not be re-debated:

- **A cold ring does not wait.** `attemptRing` boots a worker in the background and fails over
  **now** (`src/ladder.js:409`) — waiting would burn the caller's entire rung budget on a
  one-time boot, while the *next* call finds a warm ring.
- **A warming ring refuses immediately** for `WARMUP_COOLDOWN_MS = 60_000` rather than landing
  on a half-settled worker.
- **One retry**, except on `200`, `429`, `413` — a budget refusal is real (retrying inside the
  same minute is wasted) and a 413 was decided locally, so the same payload cannot fit twice.

---

## 3. How context enters: two guards, both before the clock starts

Context is not a timeout setting, but it is checked **before anything is sent**, which is the
whole point: refusing at the door costs the caller one hop, while sending costs seconds of
watchdog and still fails.

### Guard 1 — tokens: `contextCheck` (`scripts/zen-client.mjs:128`)

```js
estTokens = Math.ceil(len / 3.5)        // deliberately pessimistic — over-estimating is safe
need = input + max_tokens               // the cap covers the WHOLE request, not just input
ok   = need <= cap
```

- **The cap covers generation too**, because the server answers
  `400 "Input token count (N) exceeds … no tokens left for generation"` otherwise.
- The cap is **per model**, from `CONTEXT`: `mimo-v2.6/mimo-v2.5 = 1 048 576`,
  `nemotron-3.5-lightning = 1 000 000`, `big-pickle = 262 139`, `exo-free = 1 000 000`.
- A model **not in the table is passed through** (`unknown: true`) — never guessed. Caps are
  measured from the server's own 400 (`"prompt is too long: 1848462 tokens > 1000000 maximum"`),
  and a non-deterministic model gets the **minimum** observed cap (`big-pickle` → 262 139).
- Over the cap → `kind: 'context'`, **nothing sent, no cooldown set** — the next caller still
  deserves the rung, so this must never become a health-skip.
- Optionally `fitByTruncation` drops the oldest non-system messages until it fits, and **a job
  that truncates must report it**: a silently shortened prompt is a silently different answer.

### Guard 2 — bytes: `ZEN_MAX_INPUT_BYTES = 50_000` (`src/zen-ring.js:32`)

Above this size the free tier answers `200` with an **EMPTY body** instead of refusing. Measured
2026-10-07 over **2497 tasks**, success by input size:

| input | success |
|---|---|
| < 5 KB | 64 % |
| 5–20 KB | 68 % |
| 20–50 KB | 48 % |
| 50–100 KB | **20 %** ← cliff |
| 100–300 KB | **9 %** |
| bigger | 16–19 % |

**1073** such calls returned `200` with empty text. The ladder counts an empty body as a failed
rung anyway — so sending it buys nothing, and costs 7–12 s of zen time, a task row, a budget
bump and a wasted watchdog.

Hence `413` decided **locally**: no task, no quota, no dispatch, no retry, and the ladder walks
to the next rung at once.

---

## 4. The actual link between timeout and context

They interact only through **wall-clock time**, and the measurements say the direction
explicitly:

1. **Bigger context ⇒ longer prefill ⇒ longer answer.** The blind calls in the `exo-free` study
   (`prompt_tokens = 4`, i.e. the model did not see the input at all) were also **the slowest** —
   `19 s and 32.6 s` against `4–7 s` for normal ones.
2. **Bigger input ⇒ lower probability of an answer at all** (the table above: 64 % → 9 %).
3. Therefore **a fat input spends most of the watchdog and then returns nothing.** That is the
   reason both guards run *before* the timer matters: a refusal at the door is one cheap hop,
   a send is 7–12 s and a failed rung.

So the design rule is: **shrink the input or refuse it early; do not raise the timeout to
accommodate fat inputs.** Raising `ladder_timeout_ms` only makes the *failure* slower — the
answer still does not come, because the cliff is not a latency problem, it is a
"zen answers 200 empty" problem.

Conversely, **a large timeout is not a sign that context is wrong.** 20 s covers a cold boot
plus a normal zen answer on a *small* prompt; if a small prompt needs more than that, the ring
is cold or zen is slow, not the context.

---

## 5. Reading the failures: which class means what

Never classify on the status code alone.

| signal | class | cooldown |
|---|---|---|
| `kind: 'context'` or `413 input is too long` | decided **locally** | **none** — fast, the rung stays usable for the next caller |
| `504 watchdog fired` | caller's budget ran out | transient — the grace window may still deliver the answer |
| `cold ring — booting` / `warming up (Ns left)` | transient | short — the ring is being fixed for the next call |
| `429` **with** `retry-after` | daily quota | exact — the header counts down to 00:00 UTC, safe for a health-skip TTL |
| bare `429` («Error from provider (Console)», no headers) | provider rate limit | **unknown** — do not feed into a health-skip TTL as if it were precise |
| `200` with empty body | guard failure | treat as failed rung; the byte guard exists to stop this |

`429`/`503` digits deliberately never appear in pool error messages, because the ladder's
classifier reads a quota digit as a long skip (up to 1 h) while a cold pool is transient.

---

## 6. Decisions already made (do not re-litigate)

- **`ladder_timeout_ms` default 20 000** — covers cold boot (10–13 s) + zen (~5 s).
- **`MAX_WAIT_MS` 90 000** — edge idle timeout; beyond it you must poll, not hold.
- **`ZEN_MAX_INPUT_BYTES` 50 000** — the cliff in the 2497-task measurement; per-env overridable.
- **Byte guard rejects, does not truncate** — a silently shortened prompt is a different answer.
- **Token guard uses a pessimistic estimate** (`len / 3.5`) — over-estimating only refuses a
  request the server might have accepted; under-estimating produces a 400 after the wait.
- **Nondeterministic models take the minimum observed cap**, never the lucky maximum.
- **The cold ring fails over instead of waiting** — the boot cost belongs to the first caller's
  *fallback*, not to their budget.
