# XIO: complete local business and agent workspace

October 14, 2026 continuation specification. **Product target and gap ledger; not a completed implementation or release certificate.** Read with [ADDITIONS.md](../ADDITIONS.md), [business/advertising/funnel requirements](business-ads-requirements.md), [current status](product-status.md) and [architecture](architecture.md).

## Intent and delivery order

The user wants one locally downloadable application that can form, organize and operate a business, draft legal documents, coordinate agent teams in a Traycer-like way, control browsers and use both local and cloud virtual machines. Tools should be accessible through chat and a few useful, editable workspaces. Preserve the prior voice, themes, previews/approval, XYRA, website/funnel/email and Meta/Google Ads requirements.

Interpret "one shot app" as one installable, integrated product with guided setup and complete connected workflows. It does not promise arbitrary tasks succeed on the first model response or accounts configure themselves. Ordinary users must not need a developer checkout, npm, Rust or a manually launched sidecar. Provider account authorization and available hardware remain explicit setup steps.

The earlier instruction to create a continuation handoff remains in effect. This specification guides the next implementation cycle. Installer/source `cb0632727fc3422ec63a8773d20bfaa974d20c34` stays frozen; documentation supplements do not install missing features.

## Useful editable spaces

Keep the four existing spaces as defaults rather than one top-level tab per module. Users can rename, reorder, pin, hide and restore contextual tabs/panels, save layouts and choose business/project presets. Layout edits never change permissions or delete data.

| Default space | Actions and editable surfaces |
|---|---|
| Chat | Start/resume tasks, select agent/model, type/dictate, inspect previews, approve, steer and pause/cancel. Keep task/agent activity and outputs beside the conversation. |
| Projects / workspaces | Edit plans, boards, dependencies, requirements, business records, CRM, campaigns, legal drafts and budgets. Open contextual editors/tools with saved state. |
| World | Inspect real agents, queues and browser/computer sessions; open chat/session, assign work, take over or stop. Visual activity reflects actual runtime state. |
| Library | Search/edit authorized files, templates, clauses, knowledge, generated artifacts and reusable workflows. Show provenance, versions, diffs, comments and exports. |

Settings contains models/providers, connections/MCP, computers, permissions, approval policies, backups, notifications, themes and accessibility. Preserve File/Edit/View/Window/Help and contextual command search. Unsupported functions explain the missing prerequisite and offer setup; they never report fabricated success.

First launch: create/open a local workspace -> guided health/capability check -> configure a model -> authorize selected connections -> select an available execution environment -> complete a small previewed task. Local records/documents remain useful offline. Offline agent execution requires an actual working local model and local tools; cloud-backed tools clearly require connectivity.

## Completion inventory

Each row is a required outcome. "Foundation" describes existing source, not acceptance of the complete function. Module registration or test totals do not close these gaps.

| ID | Function | Foundation / missing delivery | Completion evidence |
|---|---|---|---|
| XIO-FULL-001 | Single-install setup and maintenance | Installer/sidecar exists; guided setup, repair/update and clean-machine lifecycle remain. | Install without developer tools, configure workspace/model, run a real task, restart, upgrade with data preserved, restore backup and uninstall predictably. |
| XIO-FULL-002 | Model/provider onboarding | Profiles/adapters exist; complete secure setup/routing remains. | Connect/test/select/revoke a provider; route to the chosen real model and show usage. Any local-model option passes a real local invocation. Secrets never enter chat/renderer storage. |
| XIO-FULL-003 | Text/voice task execution | Messages persist; general chat dispatcher is unconnected. | Persist task/run, invoke tools, verify output, handle transcript edits, steering, cancel and restart/resume. |
| XIO-FULL-004 | Editable workspaces | Four spaces/themes exist; configurable productive panels and complete editors remain. | Saved layouts and task/document edits, keyboard access, undo where supported, autosave/conflict handling and default restoration work after restart. |
| XIO-FULL-005 | Traycer-like orchestration | Queue/profile/prepared-run/evidence pieces exist; general execution and result delivery remain. | Decompose, assign, show dependencies/artifacts, message workers, resolve blockers and integrate verified results without losing work on restart. |
| XIO-FULL-006 | Agent teams/swarms | Bounded runtime/kill-state foundations exist; connected team execution remains. | Coordinator, workers and reviewer operate with scoped tools/models/budgets/cancellation. Prevent duplicate claims/conflicting writes and verify an integrated result. |
| XIO-FULL-007 | XYRA and approvals | Capability approvals exist; complete product process/preview policy remains. | Context -> proportionate plan -> preview/authorize -> execute -> verify -> checkpoint. Changed input invalidates approval; failed checks prevent completion. |
| XIO-FULL-008 | External MCP/API tools | Catalog/auth/transport foundations exist; onboarding and host dispatch remain. | Configure a supported server, discover/validate tools, perform scoped read/approved write, revoke and prove refusal. |
| XIO-FULL-009 | Internal agent browser | Complete app-owned backend absent. | Create session, navigate/read/interact/download, expose watch/takeover, pause/cancel and safe recovery/cleanup; resist page-driven privilege escalation. |
| XIO-FULL-010 | Local VMs | Complete app-owned adapter absent. | Probe support, create/start/connect/stop/destroy a supported VM, isolate credentials/files/network, transfer artifacts and recover/clean up on crash. Test published Windows support configurations. |
| XIO-FULL-011 | Cloud VMs | Complete app-owned adapter absent. | Configure provider/account/region/limits, show cost scope, create/use/stop/destroy, enforce expiry and reconcile orphaned resources. Record cleanup and remaining cost exposure. |
| XIO-FULL-012 | Secure execution | Runner production uses ClosedVerifier; full isolation/spawn/watchdog path missing. | Real verifier/isolation, fenced execution, cancellation/timeouts, bounded output and artifacts; adversarial escape and cleanup tests before enablement. |
| XIO-FULL-013 | Business administration | Corporate/Ops/Comms/Growth slices exist; business lifecycle remains partial. | Setup, roles, ownership, CRM, support, documents, schedules, financial records and daily review work as one scoped journey. See BIZ IDs. |
| XIO-FULL-014 | Web/funnel/email/ads | Builders/connectors incomplete. | Pass Emergent building rubric and Meta/Google lifecycles joined through lead capture, CRM, email, booking/test checkout and measured outcomes. See WEB/FUN/EMAIL/ADS IDs. |
| XIO-FULL-015 | Legal drafting/review | General document/corporate foundations; complete workflow unproven. | Pass intake, source/clauses, editable draft, redline, review and export lifecycle below. |
| XIO-FULL-016 | Files/knowledge/documents | Library/BRAIN lineage exists; complete editor/import/export/erasure journeys remain. | Import supported files, retrieve with provenance, edit/version/diff, export and back up; honor scoped deletion/retention without resurrection. |
| XIO-FULL-017 | Scheduled/background work | FLOW claims/checkpoints exist; host timers/providers remain. | Run schedule once, reconcile missed runs/retries, pause/revoke and restart safely. State whether jobs continue when UI closes; never claim work runs on a powered-off machine. |
| XIO-FULL-018 | Diagnostics and release | Bounded tests exist; integrated certification remains. | Account/data isolation, secret redaction, dependency remediation, accessibility, resource bounds, outage recovery and matching installer/source evidence. |

## Legal document lifecycle

This is a product requirement, not jurisdiction-specific legal advice. Draft useful editable documents with inspectable facts, assumptions, sources and unresolved decisions.

| ID | Behavior | Acceptance evidence |
|---|---|---|
| XIO-ADD-LEGAL-001 | Intake: document type, parties, jurisdiction/governing law, dates and commercial terms. | Missing facts become questions/placeholders; never invent identities, authority or legal conclusions. Revisions propagate to the draft. |
| XIO-ADD-LEGAL-002 | Versioned templates/clauses with provenance and suitability metadata. | Draft an NDA and service agreement from supported templates; retain version, source/date, user facts and unresolved clauses. Jurisdiction-sensitive research uses current primary sources and flags unverified citations. |
| XIO-ADD-LEGAL-003 | Rich-text edits, alternatives, tracked changes/redlines, comments, approvals and comparison. | Accept/reject edits, resolve comments, compare and restore drafts without losing authorship or review history. |
| XIO-ADD-LEGAL-004 | Portable deliverables/review packets. | DOCX/PDF/plain-text exports match the approved version, preserve formatting, remove unwanted review metadata on request and pass rendering checks. |
| XIO-ADD-LEGAL-005 | Separate draft, human review, signature and filing states. | Route an exact version to a reviewer or configured service and store real receipts. No signed/filed/legally sufficient/professionally reviewed claim without corresponding evidence. |

Scope sensitive files and retrieval to the business; let the user choose reviewers/sharing. List supported jurisdictions and document types honestly. A template sample does not prove comprehensive legal coverage.

## Orchestration and computer behavior

Use a coordinator with owned subtasks and bounded workers rather than uncontrolled recursive spawning. Assign scope, model, tools and budget per run; record parent/child relationships, dependencies and artifacts. Independent review is distinct from another agent's draft. Shared files need worktree/branch or equivalent conflict control; integration requires verification.

Every task has durable identity/revision, state, checkpoints and result. Show queued, running, waiting-for-approval/input, paused, failed, cancelled and completed accurately. Acknowledge steering and apply it at a safe boundary; never silently change in-flight approved work. Display concise decisions and evidence, not hidden chain-of-thought.

Browser contexts, host processes, local VMs and cloud VMs remain distinct environment types. Users select supported environments per task, inspect sessions and stop them. Do not silently substitute an unsupported backend. Cloud accounts, local virtualization and configured resource/spend limits are real prerequisites, not missing developer approval.

## Technical constraints and open choices

Extend Tauri + sidecar + capability bus + scoped PGlite; do not create a parallel chat tool authority. Preserve the 16 modules, additive migrations, public injected ports and data ownership. Compose cross-module workflows in trusted host/runtime code; layout settings do not grant permissions.

Complete conversation/task revision -> durable run admission -> selected model/executor -> typed capability -> persisted progress/artifacts -> verifier -> result. Claims need leases/fences; retries need idempotency and remote-state reconciliation. Run/approval/artifact/connector provenance must explain results after restart.

Use native/server credential storage and scoped broker access. Previews bind exact inputs/targets/version to server decisions. Auto-approval applies only where capability policy permits; current consequential/high-risk prohibitions remain manual until an explicit reviewed policy change. A renderer toggle or developer approval cannot open C1 or mint tool authority.

Open implementation selections: local VM backend/guest image and licensing, cloud provider/account, supported local-model runtime, email/signature providers, legal-template jurisdictions. Select/validate adapters during implementation; record rationale and unsupported configurations. Installing an SDK does not prove an operational backend. A first supported adapter is a useful slice, but both local and cloud VM journeys are required for the full target.

## Next implementation sequence

This continuation map does not rewrite completed tickets. Reconcile owner checkpoints against current Git history before applying them; do not duplicate cherry-picked equivalents.

| Slice | Deliverable | Exit gate |
|---|---|---|
| 1 | Inventory, guided model setup, durable chat admission/execution | Real model performs a scoped read and approved write with verified output; no success stub. |
| 2 | Editable spaces/documents, previews and team orchestration | Two workers and reviewer complete work with steering, cancellation, conflict handling and durable restart. |
| 3 | Browser, secure runner, local/cloud computers | Actual lifecycle, isolation, limits, takeover and cleanup; failure tests keep authority closed. |
| 4 | Legal documents and business workflows | Useful editable documents plus connected CRM/operations/financial records with review/export evidence. |
| 5 | Web/funnel/email, Meta/Google and MCP/API flows | Both ad integrations and acquisition journey pass; missing live prerequisites remain explicit. |
| 6 | Scheduling, resilience, accessibility, package/update and release | Installed clean-machine journeys, backup/restore, exact binary/source manifest and disposition of every requirement. |

Independent slices may progress with explicit ownership and stable interfaces. Missing R2, passkeys or paid accounts do not block all code work; continue unblocked implementation/tests while retaining specific live-evidence gaps.

## Full-product release gate

On one frozen installed candidate demonstrate setup, real chat/tool action, editable/recoverable workspace, bounded multi-agent delivery, legal draft/redline/export, browser work, supported local and cloud VM lifecycles, business/funnel/email and both ad connectors, safe scheduled restart, update/backup/restore and accessibility. Record actual outcomes, not page counts or test totals alone.

For every ID record entry points, tests, candidate SHA, prerequisites and PASS/PARTIAL/BLOCKED disposition. Use measured reference journeys before claiming MadeThis/Polsia/Emergent/Traycer parity. The existing continuation installer remains valid for its stated partial scope, but is not this complete product. Preserve PAPER-only INVEST and distinguish development approval from production distribution or customer-account spending.
