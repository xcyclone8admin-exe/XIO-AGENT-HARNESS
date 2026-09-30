# Workspace Hub storage lifecycle

The workspace Durable Object owns the hot synchronization boundary. A push commits its row state, server sequence, compacted pull log, conflict records, idempotency outcome and reference edges in one SQLite transaction. Reads page by rows, bytes and a scan ceiling. Request quotas limit write pressure; expired leases and idempotency entries are removed by alarms and on requests. Lease fences remain in `hub_counters` after cleanup.

Quotas are enforced per principal, workspace and fixed public endpoint path, for requests and ingress bytes. The public Worker supplies the endpoint identity after JWT verification; only the Worker can call the token-protected Hub route. Blob PUT redemption charges its declared size against the same quotas.

The pull log is compacted on every write: an older field version is removed when a newer version of that field is accepted. A cursor can resume through gaps because server sequence numbers are never reused. This bounds hot log growth for frequently edited fields. Append rows and conflicts remain immutable, so their size can still grow with legitimate activity.

Before enabling production workspaces, phase 2 must add the approved Neon persistence adapter and offload old immutable append and conflict records. The offload protocol is: write a batch with workspace, sequence range, record checksums and a durable manifest to Neon; verify the batch from a separate read; commit a checkpoint in the Hub; only then delete checkpointed hot records. The pull API must serve across the checkpoint or return a signed resync marker with a complete snapshot. Conflict pages must read checkpointed history from Neon before hot SQLite, preserving order and access filtering. Failed or partial offloads leave the hot records intact and are retried idempotently. No current code deletes conflict history or append rows to satisfy a quota.

The current Hub remains a staged implementation. Its per-DO storage growth and recovery cannot be certified until the Neon adapter, checkpoint reader, restore test and live storage limits are verified.
