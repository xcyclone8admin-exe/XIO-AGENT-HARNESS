# FORGE module

FORGE stores software project hierarchy, spec corpus records, provenance-ranked context manifests, human approval references, bounded scheduler plans, reviewer findings, evidence and promotion/rollback records.

## C1 execution boundary

This package has no host process, shell, runner, network, credential broker, Git ref mutation, deploy, or production promotion implementation. The scheduler computes a queue plan and always returns `externalExecution: false`. Chaos requests can only describe an authorized sandbox/staging target and return `executed: false`. Factory adapters are schema constrained to `enabled: false`. Production promotion requires an approval record scoped to the exact workspace, commit, source and destination. Staging/main promotion remains a record only; the actual runner is an unavailable dependency and must pass its escape suite before an execution client may be integrated.

## Requirement coverage handoff

Statuses below describe this isolated branch. No candidate commit test output or hashed QA evidence has been produced, so no requirement is represented as formally PASS.

| Requirement | Branch disposition | Module evidence target / limitation |
|---|---|---|
| XIO-REQ-FRG-001 | PARTIAL | `server/state-machine.ts`, `contracts.ts`; hierarchy records and legal transition tables. Full CRUD UI/persistence and candidate verification remain. |
| XIO-REQ-FRG-002 | PARTIAL | `server/compiler.ts`, `server/specs.ts`; 12 deterministic templates, stable IDs, dependency/supersession metadata and content hash. Templates intentionally remain drafts. |
| XIO-REQ-FRG-003 | PARTIAL | `server/compiler.ts`; 9 typed elements, provenance ranking and hard token budget. Must execute the candidate tests to establish evidence. |
| XIO-REQ-FRG-004 | BLOCKED | C1/ADR-0013: no runner, process execution, secrets, egress or worktree lease path in this package. |
| XIO-REQ-FRG-005 | PARTIAL | `server/engine.ts`; approval, dependency, concurrency, resource-lock, budget and kill-switch planning. It never launches a run. |
| XIO-REQ-FRG-006 | PARTIAL | `classifyDiscovery`; classifications mark material/critical items for escalation and record affected ticket IDs. Persistent dependency-chain blocking awaits integrated service/API. |
| XIO-REQ-FRG-007 | PARTIAL | Nine council roles, structured finding schema and sandbox/staging-only chaos authorization; chaos execution disabled. |
| XIO-REQ-FRG-008 | PARTIAL | Deterministic evidence gate evaluation precedes judgment; hard failures require authorized risk acceptance. Candidate evidence not generated. |
| XIO-REQ-FRG-009 | PARTIAL | Gate checks, approval scoping and immutable promotion/rollback record builders. No branch movement, deploy or rollback execution. |
| XIO-REQ-FRG-010 | PARTIAL | Factory adapters default to disabled and reject enabled config. External-adapter-disabled E2E candidate run is not available. |
| XIO-REQ-FRG-011 | BLOCKED | Dogfood requires WP-EXEC verified substrate and actual executed/reviewed/promoted feature; C1 expressly disables those actions. |
| REQ-AIS-002 | PARTIAL | Scheduler planning returns stopped on engaged switch; shared product kill-switch propagation, UI/API/hotkey integration and 5-second evidence belong to integrated systems. |
| REQ-DATA-001 | PARTIAL | `migrations/0001_forge_core.sql` is a module-owned initial schema; checksum/apply, RLS, append guards and upgrade-path evidence need execution in integrated migration Gauntlet. |
| REQ-003 | BLOCKED | A basic Forge module surface exists, but visual/functional parity rubric and blind review cannot be claimed from this isolated branch. |

## Verification

The lead's lock-only workspace-registration commit `840b2f6` was cherry-picked as `3bfbba2`, after which `npm.cmd ci --no-audit --no-fund` installed the locked dependencies outside OneDrive. `npm.cmd run verify` then passed on the follow-up Forge candidate: typecheck and lint succeeded; Vitest passed **133 tests in 17 files**; repository checks passed (**174 files scanned**). Module registry generation registered `[core, swarm, forge, ops]`. The final commit SHA and exact-candidate rerun result are recorded in the handoff.
