# Cloud/BRAIN erasure protocol v1

This is the agreed wire and ordering contract for `WP-CLOUD-BRAIN-ERASURE`. It does not claim
that the API or schema has shipped. Until the lead-owned verified CapabilityBus approval adapter
is wired, Cloud must deny erasure initiation and destructive transitions.

## Authority and source version

All endpoints use the existing product JWT plus DPoP and recheck current Neon membership. Cloud
derives tenant, workspace, and actor from that verified principal. The request body never carries
scope, approval state, expected references, retention/hold values, or a trusted purge boolean.
Cloud requires the explicit erasure capability and scope-bound verified approval from the
lead-owned CapabilityBus adapter. The adapter is not replaced by a shared BRAIN bearer secret or
the Hub internal token.

BRAIN sends `sourceVersion` as `sha256:<64 lowercase hex>`. It is SHA-256 over UTF-8 bytes of
canonical JSON for `{sourceId, versions:[{id,version,contentHash}]}`. Canonicalization uses compact
JSON with recursively lexicographically sorted object keys (RFC 8785/JCS semantics); the `versions`
array is sorted by numeric `version`, then lexical `id`. `contentHash` comes from BRAIN's
`content_hash` field. Cloud independently derives the current digest from trusted synced
`cloud_sync_rows` for the `brain_sources` row and its `brain_source_versions` rows, then compares it
with the request precondition. Missing, deleted, stale, or unavailable source state returns
`SOURCE_STATE_UNAVAILABLE` or an invalidated operation; Cloud never treats the posted digest as
proof of current state. BRAIN also rechecks it inside the local purge transaction.

## Wire shapes

All requests and responses carry `protocolVersion: "cloud-erasure-v1"`.

### Begin / phase 1

`POST /v1/erasures`

```json
{
  "protocolVersion": "cloud-erasure-v1",
  "erasureId": "<stable UUID>",
  "attemptId": "<UUID for this separately approved attempt>",
  "source": { "kind": "brain_source", "id": "<brain_sources UUID>" },
  "sourceVersion": "sha256:<64 lowercase hex>"
}
```

`erasureId` identifies the operation across retries. Cloud creates one stable `operationId` per
trusted `(tenant, workspace, erasureId)` and computes the request digest itself. Exact replay of
the same `attemptId` and payload returns the same operation state. Reusing an erasure or attempt
identity with a different source/version/digest returns `409 IDEMPOTENCY_KEY_REUSED`. A separately
approved retry uses a new `attemptId`, increments server-owned `attemptNo`, and retains the same
`operationId`.

The response is the durable phase-1 state, not merely an enqueue acknowledgement:

```json
{
  "protocolVersion": "cloud-erasure-v1",
  "operationId": "<Cloud UUID>",
  "erasureId": "<stable UUID>",
  "attemptId": "<attempt UUID>",
  "attemptNo": 1,
  "requestDigest": "<Cloud SHA-256 hex>",
  "source": { "kind": "brain_source", "id": "<UUID>" },
  "sourceVersion": "sha256:<64 lowercase hex>",
  "status": "eligible",
  "eligibility": {
    "reservationId": "<Cloud UUID>",
    "referenceStateVersion": 12,
    "holdStateVersion": 3,
    "expiresAt": "<RFC3339 timestamp>"
  },
  "objects": [
    { "opaqueRefId": "<Cloud UUID>", "disposition": "delete_candidate" }
  ],
  "auditReceiptId": "<Cloud UUID>",
  "updatedAt": "<RFC3339 timestamp>"
}
```

Object dispositions are `delete_candidate`, `retained_shared`, `retained_hold`, and `unavailable`.
A shared object may be retained while BRAIN removes this source's own data and edge. Any active
hold or unknown hold authority blocks local purge (`retained_hold` or `hold_unknown`). If R2 is
unavailable for any candidate object, phase 1 returns `unavailable`; no claim or local purge may
start. A source with no Cloud blob references can be eligible without R2.

### Authenticated status

`GET /v1/erasures/{operationId}` returns the current durable operation and latest receipt/event
only if the caller's revalidated tenant/workspace scope matches. It exposes opaque reference IDs,
never storage keys. BRAIN uses it for crash recovery. Phase-1 POST itself returns the persisted
eligibility/reservation result synchronously; GET alone never grants permission to purge.

### Atomic local-purge claim

`POST /v1/erasures/{operationId}/claim-local-purge`

```json
{
  "protocolVersion": "cloud-erasure-v1",
  "attemptId": "<attempt UUID>",
  "reservationId": "<reservation UUID>"
}
```

Cloud atomically locks all operation objects in stable key order, verifies the unexpired
eligibility reservation and state versions, and transitions the operation to `purge_claimed`.
The response includes `claimId` and monotonically increasing `claimGeneration`. This claim has no
automatic expiry or release: a delayed client cannot use an expired phase-1 token, and an already
claimed local transaction cannot be silently unfenced by a clock timeout.

Every Cloud reference or hold mutation locks the same object rows. Before claim, a competing
mutation may invalidate the eligibility reservation and apply its change atomically; then claim
fails. If claim wins, the mutation returns explicit `423 ERASURE_CLAIM_ACTIVE` with the operation
ID and does not change state. Hold requests are surfaced as conflicts, never dropped. BRAIN
persists `claimId` and generation in its durable operation record before the local purge and checks
the claim plus `sourceVersion` inside the same local transaction that writes purge receipt/outbox.

### Local purge acknowledgement / phase 2

`POST /v1/erasures/{operationId}/local-ack`

```json
{
  "protocolVersion": "cloud-erasure-v1",
  "attemptId": "<attempt UUID>",
  "claimId": "<Cloud claim UUID>",
  "claimGeneration": 1,
  "localPurgeReceiptId": "<BRAIN immutable receipt UUID>",
  "localPurgeReceiptDigest": "<SHA-256 hex>",
  "sourceVersion": "sha256:<64 lowercase hex>"
}
```

The BRAIN receipt ID/digest are audit evidence only; they cannot grant authority, scope, approval,
or bypass holds. Exact replay returns the same result; a mismatched receipt for the same operation
returns `409 RECEIPT_MISMATCH`. Cloud atomically stores the receipt reference, retires only the
erasing source's Cloud reference edges, then rechecks all remaining references and hold state under
the same object locks before scheduling any R2 delete. A new shared reference yields
`retained_shared`; an active or unknown hold yields `retained_hold` or `hold_unknown`; unavailable
R2 yields `unavailable`. Only zero remaining authorized references plus authoritative clear hold
state may enter `delete_pending`. Cloud reports `completed` only after R2 confirms deletion (or an
idempotent successful delete of an already-absent object) and persists its immutable receipt. If a
reference remains, Cloud records `retained_shared` for that object and does not count it as deleted.
BRAIN may finish its own local purge only after `purge_claimed`, but its overall erasure remains
explicitly incomplete while any required object is `retained_shared`.

If BRAIN crashes, its durable outbox retries the same receipt/claim. Recovery uses authenticated
GET: resend phase-2 ack if the local receipt exists; otherwise resume the local transaction under
the same claim or write a durable no-purge abort and call the abort endpoint. Cloud releases a
claim only after the matching phase-2 receipt or explicit no-purge abort. A claim remains blocked
if BRAIN cannot recover; this is a deliberate fail-closed liveness tradeoff.

### Abort

`POST /v1/erasures/{operationId}/abort` carries `protocolVersion`, `attemptId`, `claimId`, and
`abortReceiptId`/digest from BRAIN's durable record proving that no local purge committed. It is
idempotent and releases the claim without deleting remote objects. A local receipt that says purge
committed cannot be used to abort.

## Durable statuses and receipt

Operation statuses: `eligible`, `retained_shared`, `retained_hold`, `hold_unknown`, `unavailable`,
`eligibility_expired`, `eligibility_invalidated`, `purge_claimed`, `local_purge_acknowledged`,
`delete_pending`, `completed`, `aborted`, `retryable_failure`, and `terminal_failure`.

Cloud persists immutable, ordered status events and audit receipt IDs. Receipt fields bind
`operationId`, `erasureId`, trusted tenant/workspace/actor, source identity/version, attempt ID and
request digest, reference/hold state versions, local receipt ID/digest (when present), opaque
checked/deleted/retained/unavailable reference IDs, status, retry count/limit, retry-after, and
timestamps. BRAIN completion requires its durable local purge receipt plus a verified durable Cloud
final result. `retained_shared`, `retained_hold`, `hold_unknown`, and `unavailable` are never
reported as `completed` or as object deletion.
