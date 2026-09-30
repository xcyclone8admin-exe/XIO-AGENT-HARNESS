# Cloud phase‑2 operations

## Implemented locally

- Neon’s `xyra_app_login` role is the Cloud Worker runtime role. The Core migration enables and forces RLS, derives all `app.*` scope values inside a transaction from validated server context, grants current authority reads, and limits auth and job writes by table/column. Migration tests run as this exact role and cover tenant isolation, anonymous credential lookup, append receipts, and Cron overlap.
- Passkey authentication and registration use server-generated WebAuthn challenges, a five-minute transaction, loopback-only HTTP redirects in development, RFC 7636 PKCE, DPoP-bound one-time authorization codes, 15-minute EdDSA access tokens, and rotating device-bound refresh families. Every protected Worker request rechecks current membership/profile state and records a DPoP replay key.
- `POST /v1/webhooks/membership` accepts only a fresh HMAC-SHA-256 signed `membership.revoked` event. The body is capped at 256 KiB. Receipt and idempotent job rows commit together; repeated provider delivery reuses the job id and re-sends it if an earlier Queue send failed.
- The Queue consumer validates the stored job under tenant/workspace RLS, then revokes only the matching WorkspaceHub membership cache entry. That operation is repeat-safe. Wrangler config bounds retry attempts and routes poison deliveries to a dead-letter queue.
- Cron records one `dpop-replay-cleanup` run per 15-minute window and removes only expired DPoP replay rows. The Worker role’s delete policy and trigger both prevent deletion of unexpired proofs.
- WorkspaceHub SQLite remains the canonical hot sync store for accepted rows, sequence, pull log, conflict history, idempotency outcomes and reference edges. There is no shared Neon manifest-row write API; this branch creates no `cloud_sync_*` canonical row tables.

## Required live validation still blocked

No scoped `institutional-agent-os-dev` Neon project credentials or project-scoped Cloudflare resources were available during local implementation. The migration, database-backed auth flows, Queue delivery/DLQ behavior, and Cron execution therefore have not been certified against live providers. Do not enable auth routes until signing keys, an owned production RP ID/origin, and scoped runtime grants exist. Development RP configuration is limited to `http://localhost`.

Production Queue names, the dead-letter queue, Cron trigger, `WEBHOOK_SECRET`, `NEON_DATABASE_URL`, and `HUB_INTERNAL_TOKEN` must be provisioned from the approved development/production resource manifests before live tests. No deploy was performed.

The later Neon archive/checkpoint protocol for immutable append/conflict history, cross-DO recovery, restore testing, and live SQLite capacity certification remain separate open work described in [STORAGE_LIFECYCLE.md](./STORAGE_LIFECYCLE.md).
