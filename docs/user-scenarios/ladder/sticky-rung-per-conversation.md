# Sticky rung per conversation

Epic: https://github.com/trained-assist/trained-assist-llm-ladder/issues/17 · status: planned · 2026-09-29

## Value

**Actor:** a long-running OpenCode agent run on the VM (research / doctor / deepseek / free ladders), and
the owner who pays for its tokens.

**Result:** a conversation keeps being served by ONE rung for its whole life, so the provider's prompt
cache keeps hitting; a short Go wobble no longer re-sends the whole dialogue (230–250K tokens) as fresh
input. At most one rung switch — one cache miss — per conversation, and only on a hard failure of its
rung. Negative value closed at the same time: a wobble no longer drags an in-flight conversation onto
the paid OpenRouter tail.

**Evidence level: V3** — the owner's own request (epic #17, 29.09) backed by production telemetry:
477 cache misses in 2 days = 59% of all fresh input (engine storage; report
`instant-publish.trainedassist.store/p/token-spend-razbor-29-09`); misses cluster across 4–5 unrelated
chats within seconds, i.e. they follow the shared `skipUntil` windows; Workers Observability 24h:
2 263 calls, 70 served by paid OpenRouter, top Go errors are transient (timeout 110, no first token 95,
empty answer 48). Not V5: nobody works around it today, the cost is simply paid.

## Where the conversation key comes from (research, no client change needed)

opencode 1.18.31 (installed on the VM) already sends, for a non-`opencode*` provider such as our
`ladder` provider (`@ai-sdk/openai-compatible`), on every request:

- `x-session-affinity: <sessionID>` and `X-Session-Id: <sessionID>` — stable for the conversation;
- `x-parent-session-id: <parentID>` — for subagents (e.g. `research:explore`), which have their own
  `sessionID` and therefore their own pin.

So the worker can key the pin by `x-session-affinity` (fallback `x-session-id`, then an optional body
field `ladder_conversation` for non-opencode callers). Callers that send nothing (service-llm one-shot
calls, pr-autofix, benchmarks) keep today's behaviour byte-for-byte.

## Steps (EARS)

Functional blocks: `POST /v1/chat/completions` (src/index.js), `run()` (src/ladder.js), `LadderState`
Durable Object (src/state-do.js + src/state.js), response headers `x-ladder-model` /
`x-ladder-attempts`, one JSON log line per call (Workers Observability), `GET /v1/state`.

1. **First turn.** WHEN a request arrives with conversation key K and no pin for K exists THEN the
   worker picks the rung exactly as today (health skips, key rotation, probe), and on success stores
   `pin[K] = {ladder, rung, lastUsedAt}` in `LadderState`; the log line and `x-ladder-attempts` carry
   `conversation=K` and `pin=new`.
2. **Next turns, rung healthy.** WHEN a request with K arrives and `pin[K]` exists for the same ladder
   THEN the pinned rung is tried FIRST regardless of the shared `skipUntil` of that rung (another
   conversation's wobble does not move this one); success refreshes `lastUsedAt`; log shows `pin=hit`.
3. **Transient wobble on the pinned rung.** WHEN the pinned rung fails with a transient error
   (timeout, no first token, empty answer, 5xx) THEN the worker retries the SAME rung (existing spare-key
   probe + one same-rung retry within the time budget) before leaving it; the pin is not moved; the
   failure is still recorded in shared health, so NEW conversations avoid the rung.
4. **Hard failure → one switch.** WHEN the pinned rung fails hard (quota / limit / config / key pool
   parked / both retries of step 3 failed) THEN the worker fails over down the ladder as today and
   re-pins K to the rung that answered; log shows `pin=moved from→to` and the reason. This is the one
   accepted cache miss.
5. **Return from the paid tail.** WHEN K is pinned to a paid OpenRouter rung AND its original Go rung is
   healthy again THEN the next request of K goes back to Go and re-pins there (second cache miss, but
   Go is flat-rate and OpenRouter is per-token — money wins over one cache miss). A pin on another Go
   rung is NOT moved back (no gain, only a miss).
6. **Expiry.** WHEN K was not used for the pin TTL (default 30 min, longer than the provider cache
   lifetime) THEN the pin is dropped and the next request behaves as step 1. Pins are capped in count
   (LRU) so the DO state cannot grow without bound.
7. **Observability.** WHEN the owner asks "did it work" THEN `GET /v1/state` shows the number of live
   pins and per-rung counts, and the `query-ladder-logs` workflow shows `pin=moved` events per hour and
   OpenRouter descents per hour, comparable with the 29.09 baseline.

## Acceptance (from the epic, made checkable)

- Scripted N-step conversation (one K) with a forced mid-run failure of the Go rung serves every step
  from the pinned rung, and `x-ladder-attempts` shows the pin (`pin=hit` / retry on the same rung).
- A second conversation K2 started during the failure window goes to the next rung; K is not moved.
- Fleet: paid descents per hour (OpenRouter-served calls) drop vs the 29.09 baseline (70 / 2 263 per
  24h) without p95 first-token latency growing; engine storage shows no fresh-input spike on a
  long run that crossed a Go wobble.

## Non-goals

- No change to opencode or to trained-assist-agent: the key already arrives in headers.
- No pin for callers without a key (service-llm, pr-autofix, bench) — one-shot calls have no cache to keep.
- `ladder_rung` (bench pin) stays stronger than the conversation pin.
- No mid-stream failover: after the first token there is no failover (unchanged).
- Not reordering ladders or changing health/backoff policy for new conversations.

## Edge cases

- Pinned rung removed from `config/ladders.json` or the request switches ladder/role (`deepseek:review`
  vs `deepseek`) → pin is per `(K, ladder:role)`; a rung no longer in the ladder is ignored, step 1.
- Both Go keys parked → hard failure, step 4; step 5 brings K back when a key heals.
- Context overflow on the pinned rung → not a rung fault; returned as today, pin untouched.
- Concurrent requests of one K (subagents run in parallel) → each subagent has its own sessionID; the
  DO serializes updates, last writer wins, no crash.
- DO unavailable → serve without a pin (fail-open), never fail the call because of the pin.
- A spoofed/garbage key → only affects that caller's own routing; key length is capped, stored hashed.

## Open design points (decided here, reversible, flagged as risk)

1. Hard vs transient: transient keeps the pin after one same-rung retry; everything else moves it.
2. Paid tail returns to Go when Go is healthy (step 5) — one extra miss, saves money.
3. TTL 30 min, LRU cap (e.g. 5 000 pins) — tune after live data.
4. Hypothesis to check during implementation: `upstreamRequest` sends a RANDOM `x-opencode-session`
   per request to Go; if Go routes/caches by it, forwarding K there instead may raise the Go-side cache
   hit rate even without any rung switch.
