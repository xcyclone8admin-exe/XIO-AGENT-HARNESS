# Invest module

Invest provides isolated PAPER portfolios and simulated order execution. It does not contain a broker adapter, live-order route, live credential, or automatic market/custody connection.

## Trust and transaction boundary

Capability handlers derive tenant, workspace, actor, and authorization from the trusted sidecar call context. Payloads cannot select a tenant or workspace. UI and agents cannot call database transaction APIs directly.

Each approved PAPER fill, its balanced ledger posting, ledger projection updates, immutable fill row, order-state events, FIFO tax-lot changes, and post-trade monitoring share one transaction through `PaperTradeLedgerApi.withPaperTradeTransaction`. A thrown ledger, lot, or event write rolls back that fill and journal together. An order can be filled in multiple positive integer quantities up to its remaining units; each slice posts its own balanced transaction, moves through `submitted` → `partially_filled` → `filled`, and applies the same quote freshness, price, cash/position, risk, and FIFO checks. Blank quantity on the UI fills all remaining units. Statement imports and risk-control writes use the scoped `invest_paper` capability transaction; they never post actual or live ledger books.

Risk-day rows use the database's UTC date function. A fresh row is opened lazily by the first funding, approved order, price mark, fill, or halt action observed on a new UTC day; day-open NAV is the ledger-derived NAV at that first observation and daily loss starts at zero. Subsequent same-day external funding adjusts the opening NAV as a contribution. Previous-day kill state is carried forward until an explicit human resume. Risk-state reads return a safe inactive/default snapshot if no day row has been created yet.

FIFO basis uses integer proportional allocation rounded down for partial disposals. The final disposal of each lot receives all remaining basis units, so repeated partial disposals conserve the lot's original basis exactly without fractional or floating-point residue.

Amounts and quantities crossing capabilities or SQL are canonical decimal strings. Financial arithmetic uses `bigint`; no floating-point calculation is used for money or units.

## Requirement coverage

| Requirement | State in this module | Evidence / limits |
| --- | --- | --- |
| REQ-INV-001 | Uses the shared immutable, per-asset double-entry ledger. | `@xyra/ledger`; fill atomicity test in `tests/service.test.ts`; 10,000 deterministic per-asset journal cases in `packages/ledger/src/contracts.test.ts`. |
| REQ-INV-002 | PAPER portfolios, ledger-derived positions, stateful partial and complete fills, price receive/source times, market sessions, FIFO lots and immutable lot events. | `migrations/0001_investment_core.sql`, `0002_invest_controls.sql`; service tests prove two atomic fill slices, reject an overfill, reconcile final ledger balance, and dispose both FIFO lots; `tests/tax-lots.test.ts`. |
| REQ-INV-003 | Mandate drafts become effective-dated versions only after two independent direct owner/admin IC approvals. | `createMandate`, `voteMemo`, `activateMandate`; service test denies agent and single-voter approval. |
| REQ-INV-004 | Deterministic pre-trade checks use effective-dated, versioned hard limits; each new limit set requires two independent owner/admin IC approvals and creates an immutable limit-change audit row. | `risk.ts`, `invest_limit_changes`, full limit/watch/restricted controls on the mandate UI; golden denial per limit plus IC-approved version-change service coverage. |
| REQ-INV-005 | Price and fill marks persist breach alerts, auto-halt when configured limits are reached, and cancel open orders. Owners assign, acknowledge, then resolve with immutable audit events. | `invest_breach_events`; service integration test covers denial for unassigned user and the full owner flow. Alert delivery is the durable in-app queue; no external notification adapter is claimed. |
| REQ-INV-006 | Mandate versions author blocked and watch-listed symbols; restricted instruments fail closed before order proposal. No override capability is exposed. | `GuardrailLimits.blockedSymbols/watchSymbols`, IC mandate workflow/UI, `tests/risk.test.ts`; mandate approval audit records each version. |
| REQ-INV-007 | Source-cited memo, immutable votes/recusals and effective-dated approved mandate. | `invest_ic_memos`, `invest_ic_votes`, `invest_ic_memo_events`; integration tests cover approval quorum. |
| REQ-INV-008 | Only mandate drafting is agent-callable; trade sizing, approval, fill and IC voting are direct human capabilities. | Capability descriptors in `server/capabilities.ts`; `requireHumanOwner` enforces direct owner/admin for governance. |
| REQ-INV-009 | PAPER only. | All order outputs are `environment: 'paper'`; static no-broker/no-live test and network mock cover execution. No live path or secret is shipped. |
| REQ-INV-010 | Portfolio-local persistent halt works. | `invest_portfolio_risk_state` and the risk UI; global SWARM/agent kill-switch synchronization needs the sidecar event-consumer bridge, which is not present in the current capability bus. |
| REQ-INV-011 | Owner/admin can submit a custodian statement snapshot; exact cash/position matching records immutable idempotent runs and owned discrepancies. | `reconcileStatement` and the service test cover matching, content-hash validation, duplicate replay, mismatches, and unknown positions. This is manual evidence only; daily scheduled provider import is not implemented. |
| REQ-INV-012 | Versioned PAPER OHLC data and strategy run through an integer-only, next-bar simulator; simultaneous stop/target touch resolves at the stop; each side's fee is charged. | `server/backtest.ts`, immutable dataset/strategy/run tables, PAPER backtest UI and `tests/backtest.test.ts` golden repeatability fixture; service test proves version collision denial and immutable persisted run. Manual OHLC source evidence only; no connected feed is claimed. |
| REQ-INV-013 | PAPER NAV/cash marks derive from scoped ledger balances and quotes; capital flows and fills fees derive from immutable ledger/investment entries. Fixed-point TWR chains flow-adjusted intervals against sourced benchmark levels. | `0004_invest_performance.sql`, `capturePerformanceMark`, `calculateTimeWeightedStatement`, persisted versioned statements and `tests/performance.test.ts`; service tests verify owner-only capture, ledger funding flow, immutable marks/reports and repeatable output. Benchmark values are manual sourced inputs; daily auto-capture remains unimplemented. |
| REQ-INV-014 | Not implemented. | No external signal endpoint, HMAC-key integration, source allowlist, freshness enforcement, conflict policy or rate limiter is present. |
| REQ-INV-015 | Not implemented in Invest. | Investor pipeline and signed, expiring R2 data-room links belong to the Growth/Cloud integration. |

The statement UI labels its data as a manual import and computes a content hash; it is not a live custodian integration. Market quotes are manually entered PAPER inputs and are not represented as a connected feed.
