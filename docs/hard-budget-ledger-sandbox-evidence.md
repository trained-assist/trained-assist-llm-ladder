# Hard-budget ledger sandbox evidence

Issue: [#152](https://github.com/trained-assist/trained-assist-llm-ladder/issues/152)
Architecture scenario: [trained-agent-architecture#200](https://github.com/trained-assist/trained-agent-architecture/issues/200)

## Scope proven

This change adds signed, short-lived, task/run/policy-scoped capability verification and D1
reservation/reconciliation primitives. The schema and SQL were exercised against the isolated
Cloudflare D1 database `trained-assist-llm-ladder-hard-budget-sandbox` (EEUR). The smoke rows were
deleted after verification. No Worker was deployed and no provider request was sent.

The remote D1 probe inserted twelve 100-token attempts against a 1000-token ceiling. Exactly ten
reservations were created; the task row ended at `max_tokens=1000`, `reserved_tokens=1000`. A
duplicate reservation did not increase the counter. A subsequent unknown result retained a full
100-token charge; a measured 40-token result charged 40 and released the unused 60. The observed
state was `reserved_tokens=800`, `spent_tokens=140`, with eight reservations still outstanding.

Local verification on the implementation branch:

- `node --test test/hard-budget.test.js`: 6 passed.
- `npm test`: 249 passed, 0 failed, 0 skipped.
- `npx wrangler deploy --dry-run --outdir=dist`: Worker bundle passed.

## Environment boundary

Cloudflare operator identity was verified with `wrangler whoami` as `typeformowner@gmail.com`,
account `d740a05e9442c1d0feacae2dfc673e93`. The D1 test database is separate from both the live
trace and Zen databases. This evidence is a remote database component probe, not a deployed
staging Worker or generated end-to-end story.

## Remaining acceptance blockers

- No current Go, OpenRouter Chat Completions, or Zen provider has a verified preflight counter
  contract wired into the call path. `estimateTokens()` is heuristic and must not be used as a
  hard token boundary.
- Capability issuance by the trusted Control Plane, authenticated transport to Ladder, and
  integration immediately before every provider attempt remain unimplemented.
- The caller-side rule “invoke the provider only when a new reservation was acquired” is not yet
  integrated into the Ladder retry/streaming state machine.
- Provider-specific output clamping, streaming usage settlement, retries/failover reservations,
  and a generated sandbox E2E remain open.
- The Ladder repository has no accepted staging Environment Contract; see
  [issue #66](https://github.com/trained-assist/trained-assist-llm-ladder/issues/66).

Therefore this ledger is not enabled in the live request route. Budgeted calls must remain
disabled until the model counter contract, CP handoff, Environment Contract, component probes,
and generated E2E pass. No production rollout is authorized by this evidence.
