# BRAIN module

The module stores source metadata, immutable source versions and chunks, extraction signals, claims, promoted facts, scoped memory and versioned procedural knowledge. `contracts.ts` models the seven memory categories named as examples in Protocol 06 §38: preference, fact, project state, decision, procedure, tool knowledge and historical outcome. The architecture overview separately calls for five memory types but does not name them, and neither the WP-BRAIN requirements nor the located project input index resolves the five names. This implementation keeps the explicit Protocol 06 categories and records the count/name discrepancy as an open mapping gap instead of silently dropping categories.

## Security and data boundaries

Every row repeats tenant and workspace identifiers. Composite references, RLS policies and `LocalScopedStore` scope reads and writes. Hybrid retrieval places tenant and workspace predicates in the SQL candidate CTE before keyword rank or vector distance is calculated. Results preserve source/version/chunk citations and set `untrusted: true`; a retrieved passage can never grant tool authority. The embedding index is nullable: keyword/full-text retrieval continues when an embedding or vector index is unavailable. Embeddings record model, version and dimension and remain derived indexes, not truth.

Facts are append-only and require a matching persisted claim plus promotion provenance. The API separates agent claim creation from reviewer/policy promotion, and the database trigger validates claim equality and rejects app-role fact inserts without reviewer provenance. Contradictions are recorded when claims conflict with effective facts. Supersession points to preserved historical facts; `factsAsOf` deterministically returns effective records.

Source deletion uses `RESTRICT` across derived records, intentionally preventing silent evidence loss. The requested source deletion cascade across chunks, vectors, derived memory, R2 and caches (REQ-DATA-005) needs a coordinated cloud/blob deletion workflow and remains PARTIAL here. Procedural candidates from workflow runs are not usable as approved procedures until a reviewer appends an approved version.

## Reduced modes and open verification

No embedding provider is implemented here. Ingestion creates keyword-searchable chunks; a trusted local integration may supply versioned embeddings. Omitting query vectors uses keyword mode; vector-query failures fall back to keyword results. The module migration provisions pgvector and must be verified against both PGlite and Neon. If the extension is unavailable at migration time, the module cannot be installed yet. Golden Recall@10, complete UI state/accessibility automation, measured visual parity, and source/blob deletion integration remain PARTIAL until valid fixtures and their cross-module services exist.
