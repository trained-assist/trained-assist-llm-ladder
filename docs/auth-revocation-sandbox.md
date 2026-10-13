# Auth revocation sandbox

`wrangler.auth-sandbox.toml` deploys the Ladder source as
`trained-assist-llm-ladder-auth-sandbox` on its `workers.dev` hostname. It has no custom
domain route, Durable Object, D1, queue, provider credentials, or cron trigger. Use it only
to test authentication and `/v1/models`; it cannot serve model completions.

Deploy the Worker and set sandbox-only credentials through Wrangler's secret input:

```sh
npx wrangler deploy --config wrangler.auth-sandbox.toml
printf '%s' "$SANDBOX_LADDER_TOKEN" | npx wrangler secret put LADDER_TOKENS --config wrangler.auth-sandbox.toml
printf '%s' "$SANDBOX_CLIENT_TOKEN" | npx wrangler secret put LADDER_CLIENT_TOKEN_01 --config wrangler.auth-sandbox.toml
printf '%s' "$REVOKED_TOKEN_HASHES" | npx wrangler secret put LADDER_REVOKED_TOKEN_HASHES --config wrangler.auth-sandbox.toml
```

Verify that an unrelated sandbox token gets `200` from `/v1/models`, a listed revoked token
gets `401`, and a random invalid token gets `401`. Do not copy production provider credentials or
production token lists into this Worker. Never save token values or revoked-token hashes in this
repository. The Worker version and tested outcomes belong in the issue/PR evidence.
