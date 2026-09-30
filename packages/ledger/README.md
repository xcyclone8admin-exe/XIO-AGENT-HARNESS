# Ledger contract v1.2.0

The public API and data declarations are frozen for Money, Invest, Studio and Corporate. Existing public names, wire shapes, column types and referenced keys change additively only, under ADR-0016. `src/contracts.ts` is the machine-readable contract; version 1.2.0 adds an explicit workspace asset-registration capability to the v1.1.0 HLC scope contract. The implementation supplies typed schemas, exact arithmetic helpers, the Money-owned SQL schema, a PGlite implementation of `LedgerApi`, a Money capability adapter and initial finance/ledger/reconciliation screens. Hosted storage adapters, sidecar runtime wiring, finance documents and Invest behavior remain open.

Import schemas and types from `@xyra/ledger/contracts`; import arithmetic helpers from `@xyra/ledger`. Server implementations consume `LedgerApi`. Only Money hosts the `money.ledger.*` capabilities; dependent modules should not re-register them.

## Data ownership and references

Money owns all `ledger_*` DDL in `modules/money/migrations`, starting at `0001`. Invest owns its DDL in `modules/invest/migrations`, also starting at `0001`. Migration sequences are gap-free. Invest, Studio and Corporate must each declare `dependsOn: ['money']` in both `package.json.xyraModule` and their manifest before referencing these objects.

Every ledger table carries non-null `tenant_id uuid` and `workspace_id uuid`. The five externally referenceable tables also carry non-null `id uuid`. Dependent FKs include tenant/workspace; a bare globally unique id is not the scope boundary.

| Stable target         | Reference key                     | Additional frozen columns                                                                                                                                                                                                     |
| --------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ledger_assets`       | `(tenant_id, workspace_id, code)` | `code text`, `scale integer`, `kind text`, `name text`, `created_by uuid`, `created_at timestamptz`                                                                                                                           |
| `ledger_books`        | `(tenant_id, workspace_id, id)`   | `name text`, `environment text`, `base_asset text`, `owner_module text`, `purpose text`, `subject_id uuid NULL`, `created_by uuid`, `created_at timestamptz`                                                                  |
| `ledger_accounts`     | `(tenant_id, workspace_id, id)`   | `book_id uuid`, `environment text`, `code text`, `name text`, `type text`, `created_by uuid`, `created_at timestamptz`                                                                                                        |
| `ledger_transactions` | `(tenant_id, workspace_id, id)`   | `book_id uuid`, `environment text`, `effective_date date`, `description text`, `source text`, `correlation_id uuid NULL`, `reverses_id uuid NULL`, `posted_by uuid`, `posted_at timestamptz`                                  |
| `ledger_entries`      | `(tenant_id, workspace_id, id)`   | `transaction_id uuid`, `line_no integer`, `book_id uuid`, `environment text`, `account_id uuid`, `asset text`, `units numeric(38,0)`, `memo text NULL`, `external_ref text NULL`, `created_by uuid`, `created_at timestamptz` |

Columns above are non-null except those marked NULL. Receipt columns default to `now()`; other listed fields have no SQL default. Their nullability, bounds and default/required semantics are also declared in `LEDGER_TABLES.columns`. `base_asset` and `asset` reference the scoped asset code; UUID relationships declared with `references` require real scoped FKs. `subject_id` and `correlation_id` are opaque domain identifiers, so Money has no reverse dependency on its consumers.

`ledger_balances`, `ledger_reconciliation_runs` and `ledger_discrepancies` are internal ledger relations. Consumers use the API outputs for these rather than adding foreign keys to their implementation details. Balances are an RLS table, never a materialized view, and carry the required `as_of_hlc` watermark. `LedgerScope.hlc` is the trusted scope stamp the engine applies to projection updates. Money's capability adapter supplies a server-side `HybridClock` stamp for writes; direct engine callers must supply a trusted HLC when a posting should advance that watermark.

## Posting and arithmetic semantics

- Every asset scale is an integer from 0 through 18 and becomes immutable on registration. Built-in assets are descriptors, not automatically seeded financial records.
- Wire amounts are canonical base-10 integer strings; TypeScript arithmetic uses bigint; SQL uses `numeric(38,0)`. Zero is `"0"`; `"-0"`, exponents, fractions and JSON numbers are rejected by the money schemas.
- Positive entry units are debits; negative units are credits. A posting has 2–499 non-zero entries and must balance independently for every asset. One transaction plus its entries fits the shared 500-row sync ceiling; the shared byte ceiling still applies separately.
- Every posting belongs to one book and one immutable environment (`actual`, `paper`, `live`). Aggregate inputs require an environment with no default. `live` postings must fail with `LIVE_TRADING_DISABLED` in the shipped engine.
- A repeated transaction id with an identical payload returns `exists`. Reusing an id with a different payload must fail with `IDEMPOTENCY_CONFLICT`. Duplicate non-null `(account_id, external_ref)` within the tenant/workspace records a discrepancy and returns `duplicate` without a second posting.
- Corrections insert a reversing transaction. `reversedById` is derived from the reversing row's `reverses_id`; the original posting is never updated. A transaction may be reversed once.
- All conversions that discard precision require an explicit rounding mode. Arithmetic helpers check storage bounds on their result; sums may have wider bigint intermediates before the final range check.
- `ensureAssets` takes the verified actor id so registration can stamp the required `created_by` column.

## Sync and permission integration

The shared manifest validator accepts `LEDGER_TABLES` after foundation commit `468d2de`. Every synced/append table has typed columns, an actor field and a receipt timestamp. Reads require `money:ledger:read`. Money includes the declarations verbatim in its manifest when its migration exists.

Book/account/asset creation uses capabilities because their identity fields are immutable. Ordinary sync updates carry only allowed mutable fields. Transaction and entry rows require atomic-unit validation; the Worker must consume `LEDGER_SYNC_UNITS` and `LEDGER_NATURAL_KEYS`. These exports describe the contract; they do not automatically wire the Worker.

Financial transitions in synced workspaces are server-commit intents under ADR-0003 A1 §E. The engine/host integration must distinguish pending intents from committed results. This package's `PostResult` describes a committed result only; it must not be used to portray an offline intent as a completed posting.

No app-role DELETE grant is required. Journal rows use reversals; mutable record removal uses tombstones. The Money migration implements append rejection triggers, deferred balance and environment constraints, same-transaction balance projection, scoped FKs, and ENABLE + FORCE RLS. PGlite tests exercise these boundaries and reconciliation idempotency; they do not establish Neon parity.

## Verification boundary

`src/contracts.test.ts` checks wire rejection, numeric boundaries, generated exact-arithmetic cases, explicit environment inputs, typed manifest compatibility and capability permissions. `modules/money/tests/ledger-schema.test.ts` applies platform and Money migrations in PGlite; it checks schema/FK parity, deferred posting checks, live rejection, append immutability, no app-role DELETE, HLC balance projection, tenant isolation, `LedgerApi` queries, and reconciliation/discrepancy behavior. `modules/money/tests/service.test.ts` checks trusted capability scope derivation; `modules/money/tests/money-ui.test.tsx` checks the honest empty/setup state and PAPER labeling. `apps/sidecar/src/registry.test.ts` checks package/manifest dependency parity and alternate module migration order. Runtime registration and manifest-derived grants are being integrated by Execution Lead; invoices, subscriptions, budgets, forecasts, scenarios, Invest behavior, and Neon parity remain open.
