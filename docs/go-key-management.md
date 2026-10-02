# Go Key Management

## Where keys live

Go API keys are stored as a Cloudflare Worker secret:

```
wrangler secret list
```

The secret name is `OPENCODE_GO_API_KEYS`. It contains a comma-separated list of
OpenCode Go API keys (the pool). The first key (index 0) is the primary; the
worker rotates through the pool on key-level faults (usage limit, 429, rejected
key).

## Viewing the current pool

The worker exposes the key pool state at `GET /v1/state`:

```bash
TOKEN=$(cat ~/.llm-ladder-token)
curl -s https://llm-ladder.trainedassist.store/v1/state \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

Look at `keys.active` (currently serving index) and `keys.exhausted` (parked
keys with their park-until timestamps).

## Updating keys

To replace the entire pool (e.g. after a key is compromised or exhausted):

```bash
wrangler secret put OPENCODE_GO_API_KEYS
# Paste the new comma-separated list, e.g.:
# os_sk_60d00c482dc4__YpLlJacy5_hFyLP0TcXGamN-0uvf-qr,next_key_here
```

To add a key to an existing pool, you need the current value first. The worker
does not expose the raw key values (they are secrets). To rotate, replace the
entire pool with the updated comma-separated list.

## Removing dead keys

Dead keys (401 Invalid credential, permanently rejected) should be removed from
the pool. The worker auto-parks keys that fail with non-transient errors, but
removing them from the pool entirely avoids repeated 401 probes.

## Key lifecycle

| Event | What happens | TTL |
|-------|-------------|-----|
| Weekly usage limit hit | Key parked, worker rotates to next | 6 hours |
| 429 (rate limit) | Key parked, worker rotates to next | 15 min → 30s cap |
| 401 Invalid credential | Key parked as rejected | Permanent until pool update |
| Transient failure (timeout, 500) | No parking, retry on same key | — |

## Round-robin for Go free-tier models

Go free-tier models (`*-free` rungs like `opencode-go/space-bunny-free`,
`opencode-go/longcat-2.5-preview-free`) are Unlimited but still consume the
same key pool. To distribute load evenly across keys, the worker implements
round-robin key selection for free-tier Go rungs: each request cycles to the
next key in the pool instead of always using the active one.

This prevents a single key from being hammered while others sit idle, even
though the models themselves have no usage limit.

## Emergency: kill all Go traffic

If a key is compromised or burning through allowance too fast:

1. Rotate the pool: `wrangler secret put OPENCODE_GO_API_KEYS` with only the
   healthy keys
2. Or park all keys: `POST /v1/state/reset-keys` (resets all keys to active,
   clears exhaustion — use with caution)
3. Or remove the compromised key from the pool entirely
