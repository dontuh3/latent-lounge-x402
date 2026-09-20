# Release security and recovery notes

## Dependency decision (2026-09-20)

UUID is overridden to 11.1.1, which fixes GHSA-w5hq-g745-h8pq and retains the CommonJS v4 API used by installed consumers. Syntax, import smoke checks, and payment integration tests validate the server path.

One moderate advisory is accepted temporarily, not claimed fixed: decode-uri-component 0.2.2, GHSA-vcc3-ghjq-m6fr. It arrives through query-string in WalletConnect browser connectors (x402 -> wagmi). Importing the exact runtime payment middleware and @coinbase/x402 does not load query-string or the decoder. The service does not expose wallet-connector input; payment and JSON request sizes remain bounded. The SDK's prebuilt browser-wallet paywall is replaced with a static connection-guide page, rather than serving an unaudited browser bundle.

An override to decoder 0.5.0 would break the CommonJS query-string consumer. The precise advisory/version exception expires 2026-10-20. Re-review imports and advisory status then, and immediately if browser wallet support is introduced. npm audit still reports the moderate finding and its propagated dependents. No high or critical finding is accepted. This is risk acceptance based on reachability, not an assertion that the installed decoder is patched.

## Durable fulfillment

payment-middleware.js is an Apache-2.0 adaptation of x402-express 1.2.0. Signature verification, terms, and settlement remain delegated to the x402 SDK/facilitator. The local changes add durable prepare/commit hooks and a simple HTML paywall. X402-LICENSE and X402-NOTICE preserve attribution.

Before submitting settlement, save the generated response and the intended ledger writes to transaction-journal.json. After receiving settlement confirmation, fsync the confirmed transaction before applying ledger files and before flushing the response. Restart recovery reapplies absolute ledger values; it does not repeat increments. Identical payment retries return the original receipt and response. Reusing the payment for different request parameters returns 409.

Answer results, scoring, and consumption commit together. Identical retries of a paid answer return the original result; a changed guess gets 410. Free samples remain one attempt without a persisted answer cache.

All API ledger work is serialized in this single server process. Keep one Railway replica and the existing mounted DATA_DIR. This is not a multi-process database. Receipts are retained for recovery; monitor storage growth before scaling traffic.

## Uncertain settlements

A network failure or process crash after submitting settlement may leave a prepared journal. The server refuses further ordinary API work rather than overwriting evidence or charging again. The static website and /healthz remain available; liveness does not imply payments are available.

Use GET /api/admin/payment-recovery with the existing x-admin-key header to view the pending id, payer, network, nonce, and creation time. Do not send the admin key in a URL or paste it into chat.

If the payment settled, POST /api/admin/payment-recovery with {id, transactionHash}. The server validates a finalized successful receipt on the expected chain, with matching USDC AuthorizationUsed nonce and Transfer recipient/amount, before fulfilling. The original signed request can then retrieve its saved response without paying again. Recovered puzzles receive a fresh answer window.

If no payment occurred, wait until authorization expiry is finalized, then POST {id, action:"release-expired"}. The server confirms the nonce is still unused at finality before clearing the record. There is no unauthenticated or unverified “mark paid” button. Configure RECOVERY_RPC_URL only to a trusted RPC for the configured Base network.

The journal and receipt stores contain private operational data and belong only on the mounted volume/backups. They are gitignored and not public routes. Backups now include these records. Do not roll back to older code while a prepared journal exists; resolve it first.

## x402 v2 compatibility (2026-09-20)

The HTTP adapter advertises a canonical v2 PAYMENT-REQUIRED header and preserves the v1 JSON challenge body. It accepts either PAYMENT-SIGNATURE (v2) or X-PAYMENT (v1), rejecting ambiguous or mismatched headers. V2 accepted terms must match the server quote. Both transports use the same facilitator verification, durable journal, and replay identity. CAIP network names are normalized only for identity/recovery compatibility; actual v2 facilitator requests retain their version and requirements. Receipts are exposed under both transport header names.

Pending settlement responses and malformed success flags preserve the prepared journal for verified recovery. They must never release a payment as unpaid. Recovery validates both legacy and v2 network/amount fields. Do not roll back to pre-v2 code with v2 journal records or payment retries outstanding.

Local regression tests cover legacy and v2 purchases, term tampering, retries, storage failure, pending/disconnected settlement, and recovery. A separate compatibility check used the official @x402/core and @x402/evm 2.14.0 client with a random unfunded account and local EIP-3009 signature verification; settlement was simulated. The configured production CDP facilitator advertises exact payments for both v1 Base and v2 eip155:8453. A real paid production transaction is still required to verify end-to-end settlement.
