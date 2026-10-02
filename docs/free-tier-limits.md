# Free-tier limits: structure, granularity, precision

What each free tier actually limits, what it tells you about the remaining
allowance, and how precise that information is. Collected 2026-10-03 from the
D1 trace (`ladder_calls.attempts`), the OpenRouter key endpoint, live zen probes
through the relay IP, and opencode.ai/docs.

---

## Summary

| Tier | What the limit counts | Granularity | Remaining visible? | Precision |
|---|---|---|---|---|
| **OpenRouter `:free`** | requests per **day** (1000) + requests per **minute** (20), **account-wide** | day / minute | **yes** — `GET /api/v1/key` → `free_model_daily_requests` | exact (integer + exact reset timestamp) |
| **Zen free** (`*-free` via relay) | requests per rolling window, **per IP + per client fingerprint** | rolling, no fixed reset | **no** — body carries no numbers | reset time exact to the second (`retry-after` header) |
| **Go `*-free`** (`opencode-go/*-free`) | nothing — Unlimited per docs, never consumes the $-allowance | n/a | n/a | n/a |
| Go paid (contrast) | **USD per model per month**, windows 5h 20% / week 50% / month 100% | 5h / week / month | no — console only | n/a |

---

## OpenRouter `:free` — two limits, both account-wide

The eight `:free` rungs we use (nemotron-3-super / -ultra / -nano-omni,
ling-3.0-flash-sante, north-mini-code, dots-3-note, laguna-xs) share **one**
counter. During the 2026-10-02 storm all of them flipped to 429 at the same
instant with an identical `Remaining: 0` — proof the counter is not per model.

### 1. Daily — `free-models-per-day-high-balance`

```
HTTP 429
"message": "Rate limit exceeded: free-models-per-day-high-balance. "
"metadata": {
  "headers": {"X-RateLimit-Limit": "1000", "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset": "1790985600000"},
  "limit_source": "openrouter_free_tier_daily",
  "remedy_hint": "Wait for the daily reset (see X-RateLimit-Reset)"
}
```

- **1000 requests per day**, resets at **00:00 UTC** (`1790985600000` =
  2026-10-03T00:00:00Z).
- The only tier in the stack that exposes a **live remaining counter**:
  ```
  curl -s https://openrouter.ai/api/v1/key -H "Authorization: Bearer $OPENROUTER_API_KEY"
  → "free_model_daily_requests": {"used": 1060, "limit": 1000, "remaining": 0}
  ```
  Note `used` can exceed `limit` — rejected attempts count into it.
- Granularity: 1 request. Precision: exact.

### 2. Per-minute — `free-models-per-min`

```
"message": "Rate limit exceeded: free-models-per-min. "
"X-RateLimit-Limit": "20", "X-RateLimit-Remaining": "0",
"limit_source": "openrouter_free_tier_per_minute",
"remedy_hint": "Slow down requests to free models, or retry after ..."
```

- **20 requests per minute**, sliding minute window (`X-RateLimit-Reset` = the
  next minute boundary). This is what a tight loop hits first; the daily limit is
  what a long run hits second.

### What the storm cost us

Storm window 13:46–19:50 UTC on 2026-10-02 → `used: 1060 / limit: 1000`, i.e.
the daily budget was gone by ~19:00 UTC and stayed 429 for everyone until
midnight. The ladder then walked Go-free rungs → OR `:free` → zen, and once
those were all exhausted it fell through to the paid tail (520 paid calls in the
hour after the incident).

---

## Zen free — no counter, but an exact wake-up time

Zen free models (`space-bunny-free`, `longcat-2.5-preview-free`,
`mimo-v2.6-flash-free`, `mimo-v2.5-free`, `big-pickle`,
`nemotron-3.5-lightning-free`) answer with a body that carries **no numbers at
all**:

```
HTTP 429
{"type":"error","error":{"type":"FreeUsageLimitError",
 "message":"Rate limit exceeded. Please try again later."},"metadata":{}}
```

The gate is double (see `scripts/zen-relay.mjs` header comment): an exact
opencode-client fingerprint (User-Agent, `x-opencode-client`, `x-opencode-project:
global`, `ses_`/`msg_` ids, `stream:true`, `tools` containing `shell` + `read`)
**and** IP reputation — Cloudflare Worker egress gets 429 from every colo
regardless of auth, which is why the relay exists.

**The useful part is the header**, and it is precise:

```
retry-after: 6314   →  6219  →  6215  →  6212   (three probes, ~9 s apart)
```

`retry-after` counts down in real time, so it answers *"when exactly may I
retry"* to the second — while the remaining allowance itself is invisible.
Granularity of the limit itself is unknown (rolling window, per IP + fingerprint,
no published number).

---

## Go `*-free` — genuinely unlimited

`opencode-go/space-bunny-free` and `opencode-go/longcat-2.5-preview-free` are
listed in the Go docs as **Free / Unlimited (limited time)**. They never consume
the model's $-allowance, which is why the ladder keeps serving them while every
paid Go rung is parked during a limit incident (#69). The key carousel (#81)
only spreads load across accounts — there is no allowance to protect.

For the paid Go rungs the structure is completely different: USD per model per
month, windows 5h 20% / week 50% / month 100%, shared per workspace
(`workspace: wrk_…` in the error). Details in issue #84.

---

## Practical consequences

1. **The daily OR counter is the only thing worth watching proactively** —
   poll `/api/v1/key` (one request) and trip an alert at e.g. 800/1000.
2. **A loop can burn the whole daily budget in minutes** — 20/min is the only
   brake, and it is per minute, not per hour. Any caller that must not pay money
   belongs on the `free` ladder (#79), never on a ladder with a paid tail.
3. **Do not parse zen 429 bodies for limits** — there are none. If the relay
   forwarded `retry-after` into the ladder's error classification, the health
   skip would expire exactly when zen allows traffic again.
4. **When all three free tiers are exhausted, the paid tail is what takes the
   load.** That is by design (reliability beats price), but it makes the paid
   spend a function of how long the free tiers stay dark.