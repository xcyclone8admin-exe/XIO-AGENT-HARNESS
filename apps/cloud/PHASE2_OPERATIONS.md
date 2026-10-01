# Cloud phase-2 operations

## Implemented locally

- `xyra_cloud_runtime_app` is the Worker database login; `xyra_app_login` is its `NOLOGIN` privilege bundle. Ordered Core migrations add WebAuthn/PKCE/refresh state and then Neon canonical sync state. RLS is enabled and forced; the runtime login has no owner, superuser, role-creation or RLS-bypass rights. Sync writes use least-privilege table/column grants. Current membership/delegation is rechecked in the same Neon transaction as sync operations.
- Passkey authentication and registration use server-generated WebAuthn challenges, a five-minute transaction, loopback-only HTTP redirects in development, RFC 7636 PKCE, DPoP-bound one-time authorization codes, 15-minute EdDSA access tokens, and rotating device-bound refresh families. Protected requests recheck current authority and record a DPoP replay key.
- `POST /v1/webhooks/membership` accepts only a fresh HMAC-SHA-256 signed `membership.revoked` event. The body is capped at 256 KiB. Receipt and idempotent job rows commit together; repeated provider delivery reuses the job id and re-sends it if an earlier Queue send failed.
- Queue processing increments durable `cloud_queue_jobs.attempts`, acknowledges only succeeded jobs, marks malformed stored jobs and exhausted transient jobs `dead`, then sends a terminal envelope to the explicit `DEAD_LETTER_JOBS` producer before acknowledging. Structurally unidentifiable poison is sent to that DLQ first; failed handoff retries the source delivery. Wrangler config sets `max_retries: 3` plus a platform DLQ as the outer fallback. Both the DLQ producer binding and consumer `dead_letter_queue` target are deployment prerequisites; missing DB/auth/DLQ dependencies are operational failures and never success.
- Cron records one DPoP-replay cleanup per 15-minute window and dispatches pending sync cache outbox entries. Hub cache updates use monotonic max-sequence semantics, so overlap and replay are idempotent.
- Sync cache outbox attempts remain retryable on delivery failure; acknowledged outbox metadata is pruned in tenant/workspace-scoped batches after 30 days. Conflict history and canonical pull history are not covered by this cleanup. Idempotency responses expire after seven days.
- Neon stores sync rows, field HLC state, server sequences, pull log, immutable conflicts, idempotency results, references and cache outbox rows. WorkspaceHub SQLite contains coordination/cache state only. Details are in [STORAGE_LIFECYCLE.md](./STORAGE_LIFECYCLE.md).

## Development resources and deployment configuration

`wrangler.dev.jsonc` is the explicit Worker deployment configuration; the existing `wrangler.jsonc` remains the local/workerd configuration. The dev Worker name is `institutional-agent-os-dev-cloud`, with the already provisioned `institutional-agent-os-dev-jobs` and `institutional-agent-os-dev-jobs-dlq` queues, KV namespace `institutional-agent-os-dev-cache` (`1301301d96e340fa93f6f37f5abc0c0d`), the `JOBS`, `DEAD_LETTER_JOBS`, `CACHE`, and `HUB` bindings, `max_retries: 3`, DLQ handoff, Cron trigger, and the initial immutable DO SQLite migration tag `v1` for `WorkspaceHub`. Do not reuse or mutate `v1`; later lifecycle changes need new unique tags. The config intentionally omits R2 until the user activates R2 and a verified bucket name exists; blob redemption safely returns `BLOB_STORAGE_UNAVAILABLE` while no bucket is bound.

Worker binding names are `NEON_DATABASE_URL`, `HUB_INTERNAL_TOKEN`, `AUTH_JWT_JWK`, `AUTH_SIGNING_JWK`, `BLOB_ACCESS_SECRET`, and `WEBHOOK_SECRET`; the issuer/audience and local RP values are non-secret Wrangler vars. Current broker inventory confirms the restricted runtime DB URL grant only. Hub token and auth keys are not confirmed provisioned; webhook HMAC is required when webhook processing is enabled; blob secret and R2 bucket are unavailable while R2 is disabled. The migration owner URL `NEON_MIGRATION_DATABASE_URL` must remain in the isolated `migration` environment and is never a Worker binding. Do not hardcode `CLOUDFLARE_ACCOUNT_ID`; deployment tooling injects it separately.

## Auth signing and device proof algorithms

Cloud accepts ES256/P-256 as the preferred path and retains EdDSA/Ed25519 compatibility. Passkey
begin accepts a strict public device JWK with exactly `{kty:"EC",crv:"P-256",x,y}` or the legacy
`{kty:"OKP",crv:"Ed25519",x}`; private `d` and extra caller fields are rejected. Coordinates
must import as a valid WebCrypto P-256 public key. The Cloud-computed RFC 7638 thumbprint hashes
UTF-8 canonical JSON with EC members in this exact order:
`{"crv":"P-256","kty":"EC","x":"…","y":"…"}`. It is base64url without padding.
The device identifier remains an independent stable UUID; JWT `device_id` is not the thumbprint.

ES256 JWT and DPoP JWS use the WebCrypto JOSE/P1363 64-byte `r||s` signature. JWT/DPoP JOSE
headers use `alg:"ES256"`; Ed25519 signatures retain `alg:"EdDSA"`. A DPoP proof requires
`htu` (request URL without query/fragment), uppercase `htm`, integer `iat` within 60 seconds,
unique caller-generated `jti` (16–128 base64url-safe characters; replay is rejected), and `ath` (base64url SHA-256 of the
bound access token, refresh token, or authorization code). The public JWK in the proof must
recompute to the stored device thumbprint and must match the header algorithm. No algorithm
downgrade is attempted.

`AUTH_SIGNING_JWK` is the private signing JWK and `AUTH_JWT_JWK` is public-only; never bind the
private JWK as the verifier key. For both, `alg` if present must match the key algorithm and `use`
if present must be `sig`. `kid` is optional, but if present on either configured key it must match
the JWT header and its counterpart. Cloud verifies every newly issued access token against the
configured public key, so a keypair mismatch fails closed as `AUTH_SIGNING_KEY_MISMATCH`; metadata
matching alone is not treated as proof that the pair matches. Current configuration supports one
active signing/verifying JWK pair per Worker environment, not JWKS rotation. The JWT `sid` is an
optional UUID for legacy tokens; `/v1/auth/logout` requires it and returns `SESSION_NOT_FOUND`
when absent, and still requires the normal DPoP proof when present.

These are source-level/local workerd cryptographic checks. CNG/TPM key creation, non-exportability,
provider configuration and production key provisioning must be independently verified by
Desktop and deployment owners; Cloud support does not certify that a caller used hardware keys.

## Verification and remaining gates

PGlite migration/role/RLS tests and real workerd/Miniflare HTTP tests run locally; they do not certify live provider behavior. The dedicated Neon dev project `fragrant-resonance-90329467` is in `aws-us-west-2` (PG18, database `neondb`). `xyra_cloud_runtime_app` login and restricted role flags have been verified through the broker, but the database is currently empty and has no applied migration ledger. A read-only migration-state probe must record baseline status/checksums before any migration. `apps/cloud/scripts/apply-cloud-baseline.mjs` applies/verifies only platform/0001–0004 and core/0001 with exact source checksums; `apps/cloud/scripts/apply-cloud-sync-migration.mjs` is a separate reviewed step and refuses unless that full baseline matches.

After migration, the runtime-role probe requires two disposable pre-existing tenant/workspace fixtures; it creates uniquely identified sync rows inside a rollback-only transaction and verifies role flags, fail-closed missing scope, same-tenant visibility, cross-tenant read denial, cross-tenant write denial and rollback. PostgreSQL 18 `SET ROLE` denial and effective runtime grants still require live confirmation because PGlite records the `SET FALSE` membership bit but does not enforce it. No live schema/RLS/persistence result is claimed before that runner passes. Cloudflare Queues and DLQ and KV exist, but no Worker has been deployed. R2 is not enabled and no bucket exists. The deployment credential must be limited to the existing named dev Worker and its required Worker API operations; creating the Worker itself requires the Cloudflare Workers Admin bootstrap path. Cloudflare docs treat bindings to Queues/KV/R2 as Worker configuration; direct permissions on those resources are needed only when provisioning or accessing those resources directly. No deployment has been performed.

The approved initial development target is a no-R2, fail-closed deployment for non-blob paths; R2 activation and a verified bucket are required before enabling or certifying blob erasure, not before deploying those non-blob paths. Provision the Worker or authorized Workers Admin bootstrap, apply reviewed Neon migrations and real two-tenant tests, grant the required runtime secrets, and inspect the final API scope. Production auth remains disabled until a registrable RP ID/origin and production key material exist; development RP remains `http://localhost` only.
