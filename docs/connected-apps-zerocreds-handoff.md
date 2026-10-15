# Connected Apps: Ladder identity, ZeroCreds custody

Status: integration handoff, not a live Connected Apps API. The discarded local prototype on `codex/zerocreds-connected-users` accepted values through a ZeroCreds `http_post` destination and stored AES-GCM ciphertext in Ladder's trace D1. That duplicates the planned ZeroCreds wallet and depends on inline destinations that the hardened ZeroCreds API rejects by default. Its Worker routes, D1 tables, encryption key, shared webhook token and CI migration have been removed. No remote migration or deployment was performed.

## Ownership and data flow

Ladder may authenticate a caller with `verifyKey()` from `src/identity-repository.js` and derive a stable `userId`; the caller must not supply another owner's ID. Before wallet use, the host must also confirm that the principal is permitted to create a connection for the intended ServerlessAgence profile. A Ladder identity alone is not proof of profile authorization; define an explicit mapping or trusted assertion. Do not give a personal user feature to every active service key by default.

The trusted host then calls a ZeroCreds wallet-form operation with task intent, provider/service and proposed fields. ZeroCreds selects the owner-bound OpenBao destination and creates a short-lived form. The model receives only a form URL, form ID, expiry and value-free status reference. The browser submits provider username, password, token or cookie to ZeroCreds. **Provider login and secret values both stay in OpenBao KV v2**; the separate ZeroCreds D1 contains only the connection ID, owner/profile binding, OpenBao path/version, manifest and receipt references, state and timestamps. Ladder may cache a value-free `connection_id` for its own UI, but must not copy ciphertext, OpenBao tokens or the provider login into its trace database.

After a confirmed OpenBao write and matching D1 completion, ZeroCreds returns an opaque `connection_id`. This is an identifier, not authorization. A ServerlessAgence broker checks the run's owner/profile and requested operation before using a scoped OpenBao reader identity. Neither Ladder's model API nor an OpenCode agent receives a generic secret-read operation.

## Reusable intent from the removed prototype

- `verifyKey()` already supplies an authenticated `userId`; use it as an input to a trusted owner/profile mapping, with role and service checks.
- Generic form fields (`username`, `password`, `token`) are useful examples. Let the agent propose a task-specific schema, validate it server-side, and show the destination and purpose to the person.
- Owner-scoped session status and a provider list are useful UI concepts. Back them with ZeroCreds wallet status, not Ladder-held credentials.
- ZeroCreds' HTTP preflight marker was handled correctly in the prototype, but the OpenBao wallet uses its own mandatory canary/write/metadata/cleanup preflight; no credential webhook is needed.

## Integration acceptance

1. An authenticated Ladder user starts a generic form without sending a destination, owner ID or secret value. A service key with no explicit wallet permission and a user mapped to another profile are rejected.
2. The ZeroCreds form visibly binds the verified owner/profile, requested purpose, OpenBao storage and form expiry. The signed manifest and subsequent receipt refer to the same connection.
3. A real sandbox submission writes values only to OpenBao. The ZeroCreds wallet D1 and Ladder trace D1 contain no provider login, token, password, cookie, ciphertext copy or OpenBao service token.
4. A callback/status race and a D1 outage after a successful OpenBao write can be reconciled without writing another secret version. A foreign user cannot observe or use the connection; revocation blocks later use.
5. Existing Ladder model endpoints and ZeroCreds legacy session clients retain their current behavior. Run both repositories' test suites and a sandbox end-to-end check before exposing Connected Apps to users.

Related work: [ZeroCreds wallet issue #67](https://github.com/Zerocreds-com/zerocreds-server/issues/67), [hardened API forms PR #71](https://github.com/Zerocreds-com/zerocreds-server/pull/71), [D1 wallet metadata PR #72](https://github.com/Zerocreds-com/zerocreds-server/pull/72).
