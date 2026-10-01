# Product status and remaining work

Updated: 2026-10-01. Latest published UI milestone: **`690e18a240078a5c4c266dc5d772e9daf93eadbf`**, merging tested feature commit **`cd8a0c1505e7081fadd444af94b8b4959c841e77`** with documentation. Earlier installer baseline: **`148c6a2e150e0ffd5441c76611c48e91449dd84c`**. This is not a release certificate.

## Latest UI milestone

Delivered: Chat/Projects/World/Library navigation; real persisted conversations/messages; red-default and persistent theme selection; scoped project/source/memory/procedure reads; explicit project-create preview/confirmation; a World graph of registered modules/dependencies linked to Library; frontend menu event handlers; packaged [XYRA process documentation](xyra-process.md).

Evidence at feature commit `cd8a0c1`: root verification passed 430 tests in 64 files, typecheck/lint and checks (577 files); static export passed 66 pages; Playwright passed 2/2 workflows. The tested Forge screen had no critical Axe violations. Browser tests use the real sidecar/database with an injected test native-session bridge.

Limits: stored chat messages do not launch a general agent run. Profile preferences do not provision credentials. Project preview confirmation is a UI flow, not the planned universal server-bound preview policy. World is a module graph, not the completed agent/pixel-world experience. Native menu integration, robust voice, browser/VM adapters and rebuilt installer remain open.

## What the earlier installer baseline establishes

| Evidence | Recorded result |
|---|---|
| Module registry | 16 modules integrated |
| Root verification | 430 tests in 64 files; TypeScript, lint and structural checks passed |
| Structural scan | 573 files checked |
| Next.js export | 66 pages built |
| Native suite | 88 Rust library tests with `cloud-dev` passed |
| Sidecar packaging | Bundle staging and smoke passed |
| Connected synthetic native test | Rust launch, private route, actual PGlite decision, replay, restart and tamper rejection passed |
| Unsigned NSIS lifecycle | Built, installed, launched with healthy sidecar, repeated same-version installation, then uninstalled |
| Development Worker | Deployed; HTTPS health passed; unauthenticated signal claim correctly rejected |
| Dev Neon | Ordered migration checksums and restricted-role/two-tenant probes passed |

These are results from the original environment. Page and module counts measure integration, not completeness. Synthetic integration is not real user enrollment or a live provider transaction. An older verified result does not automatically certify a newer commit.

## Current implementation

| Area | Implemented foundation | Remaining delivery / evidence |
|---|---|---|
| Desktop and local runtime | Native supervisor, private bootstrap, capability bus, scoped database, installer | Physical TPM, real passkey journey, genuine version upgrade, native accessibility |
| Cloud | Auth, canonical Neon sync, RLS, outbox, queues, no-R2 dev deployment | Authenticated live journeys, operational/capacity evidence, R2 and blob journeys |
| MONEY / INVEST | Atomic ledger, PAPER fills, FIFO, risk controls, reconciliation, backtests and statements | Scheduled custody/provider, remaining cross-module workflows and live advisory signals |
| BRAIN | Retrieval/lifecycle, receipt-bound ingestion/erasure state, sync acknowledgement | Complete authenticated ingestion/erasure and configured storage |
| FORGE / SWARM | Durable planning, scoped runs, approvals, review drafts and receipts | Preparation/result-sink journey, human validation and execution isolation gates |
| FLOW / CONNECT | Persisted workflows and connector structures, runtime registration | Timer/provider dispatch and complete connector/browser/computer operations |
| Command / Comms / Growth | Capability-backed service/UI slices, authorization and approval linkage | Connected agent/connector and approval composition workflows |
| Corporate / Studio | Production/governance service and UI slices | Remaining writes/actions, provenance, financial/provider boundaries and integration evidence |
| Data / Intel / Ops / Core | Integrated source, schema and registry coverage | Requirement-by-requirement workflow and acceptance evidence |

Unavailable connectors must fail honestly. PAPER remains PAPER. Drafts and manually entered evidence retain their provenance.

## New XIO experience: remaining work

Accepted direction still requiring implementation or broader evidence:

- Universal text/voice chat controlling application capabilities, inline model choice, progress and mid-task steering.
- Complete productive workflows within the implemented Chat/Projects/World/Library spaces.
- XIO native/installer identity and original modern agent-world visualization beyond the module graph; black/red and persistent themes are now implemented.
- Default portable XYRA logic with proportional planning, verification and durable resume/evidence.
- Preview-and-approve plus explicit scoped, revocable automatic approval controls.
- Working File, Edit, View, Window and Help menus and keyboard behavior.
- Task-scoped internal browser automation, inspection and human takeover.
- Both local and cloud virtual computers with real backends, isolation, budgets and cleanup.

The shell milestone is committed and published. The user has now requested a continuation handoff of this current build instead of waiting for every addition. Remaining runtime work is captured in [ADDITIONS.md](../ADDITIONS.md), [product direction](product-direction.md) and [XYRA process coverage](xyra-process.md).

## External participation or infrastructure

- A user-controlled enrolled passkey/device and suitable TPM for real device proof.
- R2 activation where the provider currently returns error `10042`.
- Configured model/connector/custodian credentials and test accounts for live evidence.
- An available VM substrate and cloud provider/budget before paid provisioning.
- Signing credentials and production decisions for any later signed/public release.

Development approval has already been granted. Continue routine implementation without asking for the same permission again. Identify missing credentials, infrastructure, hardware and failed technical gates specifically rather than calling them approval blockers.

## Publication and handoff rule

Update GitHub with coherent verified commits as remaining tasks finish. Refresh affected setup, architecture, status and verification notes. Do not change partial to complete merely because a unit suite passes.

Latest user direction supersedes the earlier hold: package the implemented milestone now, with an additions Markdown file for the next Traycer. Produce installer and full source from the same frozen candidate, include instructions/checksums, and label the delivery as a continuation build. Completion of the requested features and release certification remain separate future milestones. The pre-redesign installer at `148c6a2` remains an older build and must not be substituted silently.
