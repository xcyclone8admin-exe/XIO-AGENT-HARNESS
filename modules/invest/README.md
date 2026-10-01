# Invest module

Invest provides isolated PAPER portfolios and simulated order execution. It does not contain a broker adapter, live-order route, live credential, or automatic market/custody connection.

## Trust and transaction boundary

Capability handlers derive tenant, workspace, actor, and authorization from the trusted sidecar call context. Payloads cannot select a tenant or workspace. UI and agents cannot call database transaction APIs directly.

An approved PAPER fill, its balanced ledger posting, ledger projection updates, immutable fill row, order-state events, FIFO tax-lot changes, and post-trade monitoring share one transaction through `PaperTradeLedgerApi.withPaperTradeTransaction`. A thrown ledger, lot, or event write rolls back the fill and journal together. The simulator currently executes one all-or-nothing fill per approved order; the schema's partial-fill enum is reserved and no partial-fill execution is claimed. Statement imports and risk-control writes use the scoped `invest_paper` capability transaction; they never post actual or live ledger books.

Risk-day rows use the database's UTC date function. A fresh row is opened lazily by the first funding, approved order, price mark, fill, or halt action observed on a new UTC day; day-open NAV is the ledger-derived NAV at that first observation and daily loss starts at zero. Subsequent same-day external funding adjusts the opening NAV as a contribution. Previous-day kill state is carried forward until an explicit human resume. Risk-state reads return a safe inactive/default snapshot if no day row has been created yet.

FIFO basis uses integer proportional allocation rounded down for partial disposals. The final disposal of each lot receives all remaining basis units, so repeated partial disposals conserve the lot's original basis exactly without fractional or floating-point residue.

Amounts and quantities crossing capabilities or SQL are canonical decimal strings. Financial arithmetic uses `bigint`; no floating-point calculation is used for money or units.

## Requirement coverage

| Requirement | State in this module | Evidence / limits |
| --- | --- | --- |
| REQ-INV-001 | Uses the shared immutable, per-asset double-entry ledger. | `@xyra/ledger`; fill atomicity test in `tests/service.test.ts`; 10,000 deterministic per-asset journal cases in `packages/ledger/src/contracts.test.ts`. |
| REQ-INV-002 | PAPER portfolios, ledger-derived positions, stateful all-or-nothing orders/fills, price receive/source times, market sessions, FIFO lots and immutable lot events. | `migrations/0001_investment_core.sql`, `0002_invest_controls.sql`; service buy/sell lot test and `tests/tax-lots.test.ts`. Partial fills are not implemented. |
| REQ-INV-003 | Mandate drafts become effective-dated versions only after two independent direct owner/admin IC approvals. | `createMandate`, `voteMemo`, `activateMandate`; service test denies agent and single-voter approval. |
| REQ-INV-004 | Deterministic pre-trade checks cover configured size, loss, order-rate, quote sanity/freshness, duplicate, restricted/watch, concentration, correlation, leverage, drawdown and volatility limits. | Golden cases in `tests/risk.test.ts`; limit-policy editing/approval is not yet exposed as a complete workflow. |
| REQ-INV-005 | Price and fill marks persist breach alerts, auto-halt when configured limits are reached, and cancel open orders. Owners assign, acknowledge, then resolve with immutable audit events. | `invest_breach_events`; service integration test covers denial for unassigned user and the full owner flow. Alert delivery is the durable in-app queue; no external notification adapter is claimed. |
| REQ-INV-006 | Versioned restricted/watch rules are checked before a proposal; a restricted instrument fails closed. | `invest_restricted_rules` and `checkInvestOrder`; rule-authoring and override UI are not complete. |
| REQ-INV-007 | Source-cited memo, immutable votes/recusals and effective-dated approved mandate. | `invest_ic_memos`, `invest_ic_votes`, `invest_ic_memo_events`; integration tests cover approval quorum. |
| REQ-INV-008 | Only mandate drafting is agent-callable; trade sizing, approval, fill and IC voting are direct human capabilities. | Capability descriptors in `server/capabilities.ts`; `requireHumanOwner` enforces direct owner/admin for governance. |
| REQ-INV-009 | PAPER only. | All order outputs are `environment: 'paper'`; static no-broker/no-live test and network mock cover execution. No live path or secret is shipped. |
| REQ-INV-010 | Portfolio-local persistent halt works. | `invest_portfolio_risk_state` and the risk UI; global SWARM/agent kill-switch synchronization needs the sidecar event-consumer bridge, which is not present in the current capability bus. |
| REQ-INV-011 | Owner/admin can submit a custodian statement snapshot; exact cash/position matching records immutable idempotent runs and owned discrepancies. | `reconcileStatement` and the service test cover matching, content-hash validation, duplicate replay, mismatches, and unknown positions. This is manual evidence only; daily scheduled provider import is not implemented. |
| REQ-INV-012 | Not implemented. | No versioned OHLC strategy backtest or next-bar fill simulator is present. |
| REQ-INV-013 | Basic current PAPER NAV is ledger-derived. | Full time-weighted returns, fees, benchmark-relative attribution, versioned statements are not implemented. |
| REQ-INV-014 | Not implemented. | No external signal endpoint, HMAC-key integration, source allowlist, freshness enforcement, conflict policy or rate limiter is present. |
| REQ-INV-015 | Not implemented in Invest. | Investor pipeline and signed, expiring R2 data-room links belong to the Growth/Cloud integration. |

The statement UI labels its data as a manual import and computes a content hash; it is not a live custodian integration. Market quotes are manually entered PAPER inputs and are not represented as a connected feed.
