# Cloud/BRAIN erasure protocol

This document describes the Cloud implementation on the current WP-CLOUD-2 branch. Cloud owns
the authoritative ingestion/reference/hold state and the synced row copy. Requests never supply
tenant/workspace scope, refs, hold state, a purge boolean, or an authorization proof. Routes
authenticate the existing product JWT+DPoP principal, recheck current Neon membership and
permission, and reconstruct durable capability approval in Worker code. There is no BRAIN bearer
secret or Hub-token shortcut.

## Source and reference binding

The erasure precondition is the Cloud ingestion v2 `sourceVersion`:
`cloud-ingest-v2:sha256:<lowercase-64-hex>`. Cloud recomputes it with the shared
`@xyra/contracts` helper over the finalized immutable source version, trusted tenant/workspace,
content digest, sorted unique lowercase object reference UUIDs, and Cloud reference-state version.
Cloud also checks that the current synced `brain_sources.cloud_object_ref_ids` exactly matches the
finalized Cloud-owned reference set, and that source/version rows and normalized content still
match the finalized ingestion. Missing, malformed, stale, legacy, or cross-tenant state fails
closed as unavailable/invalidated. Legacy `external_blob_refs` are not Cloud object identities.

Ingestion uses the typed shared Cloud ingestion API:

- `POST /v2/brain/ingestions` begins an authenticated source write; Cloud generates the ingestion
  ID and binds source and scope.
- `POST /v2/brain/ingestions/{ingestionId}/finalize` accepts immutable `sourceVersionId` and
  content digest only. Cloud compares the complete current sync field with Cloud-issued and
  uploaded object references before storing a finalization snapshot.
- `GET /v2/brain/ingestions/{ingestionId}` returns authenticated pending/finalized/invalidated
  state. Only explicit `text_only` ingestion can attest a complete empty reference set.
- Object upload uses the native authenticated combined upload operation. Cloud-generated object
  IDs are returned only after registry-backed issuance; storage keys are never public.

## Erasure flow

All routes use `protocolVersion: "cloud-erasure-v1"`. The operation ID is stable across separately
approved attempts; each attempt has its own `attemptId`. The Worker derives scope and actor, checks
the operation digest against durable capability approval, and serializes sync/ref/hold mutations
with the workspace sequence lock.

1. `POST /v1/erasures` accepts `erasureId`, `attemptId`, `approvalId`,
   `source:{kind:"brain_source",id}`, and the v2 `sourceVersion`. It stores an immutable event and
   returns durable eligibility, reservation, reference/hold versions and per-object dispositions.
   Body-supplied scope or refs are rejected.
2. `GET /v1/erasures/{operationId}` returns the authenticated current operation and latest event.
   Status reads do not grant purge authority.
3. `POST /v1/erasures/{operationId}/claim-local-purge` accepts `attemptId` and
   `reservationId`. Under the workspace and object locks it revalidates source/ref/hold state and
   atomically records a stable claim ID plus monotonically increasing generation. The claim does
   not expire automatically. Conflicting reference/hold mutations must fail explicitly while the
   claim is active; a timestamp alone cannot fence an authorized delayed client.
4. After its own atomic local purge and durable receipt, BRAIN calls
   `POST /v1/erasures/{operationId}/local-ack` with attempt, claim ID/generation, receipt ID/digest,
   and the same sourceVersion. The receipt digest is audit evidence, never authority. Cloud
   rechecks refs and holds, scrubs attributable synced content and history, detaches surviving
   cross-source `supersedes_id` pointers, and schedules only eligible object deletion.
5. Cloud performs idempotent R2 deletes outside the Neon transaction, then persists the resulting
   object and operation status. A crash between provider delete and DB update is recoverable by
   replaying the same acknowledgement/delete. Retryable failures retain the durable operation and
   bounded retry count. Missing R2 is `unavailable`, never success.

Shared objects are `retained_shared` and are never counted as deleted. Holds or unknown hold
authority block deletion. Local-purge acknowledgement may remove this source's own references,
but BRAIN must not report overall erasure complete while required Cloud content/object disposition
is retained or unavailable.

## Cloud copy deletion boundary

Cloud removes explicit BRAIN source lineage only: source/version rows; chunks and signals by direct
source or source-version fields; claims through signals; promotions/facts through claims;
contradictions through claim or fact lineage; and memories by source/source-version fields.
Historical `supersedes_id` edges do not imply ownership: surviving facts/memories have only edges
to deleted owned facts/memories detached and counted. `brain_procedures.source_run_id` is workflow
lineage and is not inferred as source ownership.

The operation deletes attributable `cloud_sync_rows`, field sequence, pull log, conflicts,
idempotency payloads and reference edges, then writes content-free deletion fences/tombstones for
the exact removed row identities. This prevents stale client pushes from resurrecting erased
content. It deletes source ingestion/reference provenance used for content recovery while retaining
minimal non-content erasure audit/fence records. Cloud backup retention and provider-level backup
purge are not certified by this API and must remain an explicit deployment/data-retention limit.

## Schema and verification

Core migrations `0008_cloud_erasure_sync_delete.sql`,
`0009_cloud_erasure_provenance_delete.sql`, and `0010_cloud_erasure_deleting_state.sql` add the
RLS-scoped runtime DELETE privileges and the `deleting` object state needed to prevent reissuance
while provider deletion is in flight. Each migration is additive and follows Core migration order.

PGlite tests cover explicit lineage deletion, survivor-edge detachment, content-free stale-row
fences, receipt replay and tenant scope. Workerd HTTP tests cover authenticated route behavior and
fail-closed responses when Neon is absent. These are local fixture results, not live Neon PG18/RLS
or R2 certification. No deployment has been performed.
