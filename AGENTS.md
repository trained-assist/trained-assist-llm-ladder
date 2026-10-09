# Ladder environment contract

Use isolated branches and worktrees; preserve other sessions and existing PRs.
Never print credentials, prompts, model replies or raw provider errors in public
evidence. Retired GCP relay services must not be called.

## Local and sandbox

`npm test` exercises the actual handler with fake providers and storage. Bundle
with the existing Wrangler configuration in dry-run mode. These checks require
no live model or Cloudflare writes. Diagnostic trace writes may run through the
Worker execution context's `waitUntil`; execution, budget reservations and
provider settlement must retain their existing durability requirements.

## Production

The existing `.github/workflows/ci.yml` promotes reviewed main after tests and
bundle checks to `trained-assist-llm-ladder` and verifies its public revision.
Architecture issue #236 authorizes this path for classifier fixes. Preserve
shared bindings, provider configuration, queues and databases; do not reset
state or provision paid resources. Live checks use bounded synthetic requests
through the approved shared ladder, correlate trace IDs and reconcile unknown
outcomes before any repeat. Public health proves deployment, not model quality.
