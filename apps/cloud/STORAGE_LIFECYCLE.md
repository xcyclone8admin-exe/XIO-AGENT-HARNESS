# Cloud sync storage lifecycle

## v1 source of truth

Neon is the durable relational and sync source of truth. Core migration `0002_cloud_sync.sql` creates tenant/workspace-scoped row state, per-field sequence metadata, compacted pull changes, immutable conflict history, idempotency outcomes, reference edges, workspace sequence counters, and the cache invalidation outbox. The Worker runs a push under one `xyra_app_login` transaction after setting tenant/workspace context from verified claims and rechecking current membership and delegation in that transaction. Sequence allocation, row/field HLC state, conflict records, log compaction, idempotency response, and outbox rows commit or roll back together.

The Core migration chain is platform migrations first, then `core/0001_cloud_auth.sql`, then `core/0002_cloud_sync.sql`. `0001` is immutable. The runtime login (`xyra_cloud_runtime_app`) is separate from the migration owner and inherits the `NOLOGIN` privilege bundle `xyra_app_login` with `INHERIT TRUE`, `SET FALSE`, and `ADMIN FALSE`; it has no `BYPASSRLS` and receives scoped row policies and operation/column grants. The only cross-tenant permission is read-only access to minimal pending outbox metadata, needed by the Worker’s scheduled dispatcher; dispatch updates require tenant/workspace context. PGlite coverage applies the ordered migrations and exercises the login role, row isolation, grant boundaries, atomic rollback, conflict retention, pull/replay and outbox recovery. PostgreSQL 18 must still verify that `SET ROLE` is denied for the runtime login.

WorkspaceHub SQLite holds coordination and cache state only: membership and kill-switch cache, leases/fences, request quotas, device health, hibernatable sockets, and a monotonic sync high-water mark. `/internal/sync/cache/advance` applies `max(current, delivered)` and broadcasts only a newly advanced value. It never stores or serves canonical rows, pull changes, conflicts or idempotency outcomes.

## Cache delivery and recovery

Every accepted server sequence inserts an outbox row in the Neon transaction. After commit, the Worker attempts to advance the Hub cache. It marks rows delivered only after the Hub acknowledges; any failure leaves the durable rows pending. Scheduled maintenance scans pending workspace high-water marks and replays them. Duplicate and overlapping delivery is safe because the Hub update is monotonic. A stale or unavailable Hub cannot undo accepted Neon state; a later scheduled pass retries the cache update.

Pull reads are bounded by rows, bytes and scanned candidates. LWW changes are compacted per field: a superseded field value is removed from its old change, while other fields in that change remain. Append records and conflicts are retained; conflict reads are permission-filtered and paged. Idempotency records expire after seven days. Delivered cache-invalidation outbox rows are pruned after 30 days in bounded tenant/workspace-scoped batches. No quota cleanup deletes conflict history or accepted append history.

## Cutover and live evidence

Local PGlite tests validate the schema and Worker grants; Miniflare/workerd tests validate the Hub cache coordinator. Neither is live Neon evidence. The dedicated development Neon project and restricted runtime login now exist, but the development database is empty: ordered platform/Core baseline migrations, `0002_cloud_sync`, disposable tenant fixtures, and live two-tenant RLS checks remain pending. A separate migration owner binding exists only in the isolated migration environment. Live provider Queue/DLQ operation and cache recovery also remain unverified.

No deployment has been performed. Before any deployment or public cutover, the owner must decide and test how existing WorkspaceHub-canonical v1 state is exported and backfilled into Neon; this branch does not silently discard or automatically migrate any already-deployed DO data. Live Neon restore/capacity certification is also outstanding.
