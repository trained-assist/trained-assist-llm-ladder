# Hard-budget sandbox environment contract

This target exists only to verify the sandbox quota path from signed capability through Ladder's
provider boundary. It is isolated from production: it has a dedicated Worker, Durable Object
namespace, and D1 binding; it has no custom domain or route. The provider fixture is a second
Worker reached by a Cloudflare Service Binding and returns synthetic OpenAI-compatible responses.
It never calls an external model.

## Pinned resources

| Resource | Target |
|---|---|
| Cloudflare account | `typeformowner@gmail.com`, `d740a05e9442c1d0feacae2dfc673e93` |
| Ladder Worker | `trained-assist-llm-ladder-hard-budget-sandbox` |
| Provider fixture Worker | `trained-assist-llm-ladder-budget-provider-mock` |
| Ledger D1 | `trained-assist-llm-ladder-hard-budget-sandbox`, `a717bc1d-fd70-400f-bace-9223de176ebe` |
| Ladder route | Worker `workers.dev` endpoint only; no custom domain |
| Budget mode | required; `sandbox-v1`; 256 output tokens per attempt; 8192 aggregate estimate tokens |

Before any Cloudflare operation, `wrangler whoami` must show the account above. The deploy script
rechecks the account, exact Worker and D1 identities, and absence of routes before deploying.

## Secrets and setup

Use synthetic secrets generated for this sandbox. Do not reuse production Ladder or provider
credentials. Set `LADDER_TOKEN`, `HARD_BUDGET_HMAC_SECRET`, and `OPENROUTER_API_KEY` on the Ladder
Worker; set `MOCK_PROVIDER_TOKEN` on the provider fixture Worker. `OPENROUTER_API_KEY` must equal
the fixture's `MOCK_PROVIDER_TOKEN`. The provider base URL is the fixture's `/v1` workers.dev URL.

Create a private local directory and a single mock-provider key; install the same value in both
Workers. The files are temporary, mode 0600, and must not be committed:

```bash
secret_dir=$(mktemp -d /private/tmp/ladder-budget-secrets.XXXXXX)
chmod 700 "$secret_dir"
openssl rand -hex 32 > "$secret_dir/mock-provider-token"
openssl rand -hex 32 > "$secret_dir/ladder-token"
openssl rand -hex 32 > "$secret_dir/budget-hmac-secret"
chmod 600 "$secret_dir/ladder-token" "$secret_dir/budget-hmac-secret"
chmod 600 "$secret_dir/mock-provider-token"
npx wrangler@4 secret put MOCK_PROVIDER_TOKEN --config wrangler.budget-provider-mock.toml < "$secret_dir/mock-provider-token"
npx wrangler@4 secret put OPENROUTER_API_KEY --config wrangler.hard-budget-sandbox.toml < "$secret_dir/mock-provider-token"
npx wrangler@4 secret put LADDER_TOKEN --config wrangler.hard-budget-sandbox.toml < "$secret_dir/ladder-token"
npx wrangler@4 secret put HARD_BUDGET_HMAC_SECRET --config wrangler.hard-budget-sandbox.toml < "$secret_dir/budget-hmac-secret"
```

Generate the Ladder bearer token and HMAC secret separately in the same private directory. Never
place these values in source, command-line arguments, logs, issue comments, or evidence. Remove the
directory after the E2E; the deployed Worker secrets remain managed by Wrangler.

Deploy the provider fixture with `wrangler deploy --config wrangler.budget-provider-mock.toml`.
The dedicated config pins the fixture URL and Service Binding. The deploy script refuses a dirty
worktree and reports the exact clean source revision from `git rev-parse HEAD`; run
`npm run deploy:sandbox:hard-budget` after committing the reviewed sandbox source.

## Probe and expected evidence

Submit a signed `x-ladder-budget-capability` for policy `sandbox-v1`, with a unique synthetic task
and run ID, to `POST /v1/chat/completions` using the sandbox `LADDER_TOKEN`. The mock returns 24
input and 3 output tokens. A successful response must have one settled reservation, zero reserved
tokens, and 27 spent tokens. Repeating with an exhausted aggregate allowance must return 429 and
must not reach the provider fixture. A forged or absent capability must be rejected before
provider invocation. A streaming request must settle from its terminal usage event; disconnects
retain an unknown reservation.

The fixed mock usage tests reservation ordering, output bounds, and settlement mechanics. It does
not calibrate the estimator; that requires separate declared text/model fixtures against an
approved real provider account and remains an acceptance item before enabling a real sandbox lane.

## Cleanup

Read-only counts before/after are `ladder_budget_tasks` and `ladder_budget_reservations`. Delete
only the task/run IDs created by the specific probe, deleting reservation rows before their task
row. Do not truncate the D1 or reuse the shared Telegram UX lane. Leave the two sandbox Workers
available for repeated tests; remove them only through an explicit sandbox teardown after active
probe IDs and reservations have been reconciled.

## Boundaries and current limitations

- Production Worker configuration, custom domain, provider secrets, and Telegram routes are not
  part of this contract.
- `zen-rings` is skipped for capability-bearing calls until its internal retry/provider dispatch
  boundary can reserve independently.
- CP and Communication do not yet mint/forward this capability, so this contract proves the
  Ladder component only, not CP → Communication → Ladder end-to-end.
- Provider reported usage and estimate remain separate; user billing is disabled.
