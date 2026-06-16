# Working with this repo

## Recommendation ≠ authorization (read first)

When the user asks what you **suggest / recommend / think / would do**, or to
compare options or explain reasoning — that is a request for **advice only**.
Give the recommendation and the reasoning, then **stop and wait**.

Do **not** edit files, run mutating commands, commit, or push until the user
gives an explicit, unambiguous go-ahead (e.g. "do it", "go ahead", "yes,
proceed"). Answering a question is not permission to implement the answer. If
you are unsure whether action has been authorized, ask before acting.

## What this is

`latent-lounge-x402` — the Latent Lounge arcade **server** (Express, ESM,
`server.js`). Agents pay per play in USDC over the x402 protocol. This is a
service you deploy, not an npm library others install.

## Pre-publish / pre-deploy gate

Run before pushing or deploying:

```
npm run gate          # scripts/pre-publish-gate.sh
```

Four hard checks (non-zero exit blocks): `node --check` on tracked JS · secret
scan of tracked files · sandbox boot (temp DATA_DIR, throwaway port, dummy
wallet) probing free routes + the 402 paywall · `npm audit` policy.

- **Dependency policy:** `.audit-allowlist.json` lists accepted-known advisories
  (the x402 SDK's transitive web3/wallet-connector tree, unreachable from server
  code). The gate FAILS on any critical, or any advisory not in the allowlist.
  Triage new advisories — fix, or add with justification + review date.
- `form-data` is pinned to a patched version via the `overrides` block; don't
  drop it without re-checking `npm audit`.
