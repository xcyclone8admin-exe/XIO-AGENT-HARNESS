# XIO task process (XYRA)

This document ships with XIO and describes the intended governed workflow. It is not a claim that every stage is currently backed by a connected runtime.

## Task lifecycle

| Stage | Required behavior | Current implementation evidence |
| --- | --- | --- |
| Context | Bind the authenticated tenant, workspace, project and task revision. | Sidecar capability calls derive principal/workspace scope. Chat has not yet been bound to an executable task revision. |
| Understand | Classify the request and retrieve applicable requirements, process guides and approved knowledge. | Forge context compilation and Brain search are scoped capabilities; general chat does not yet invoke them automatically. |
| Plan | Record a proportionate plan, expected outputs and dependencies. | Forge stores project hierarchy, context manifests and schedule records. |
| Preview | Show exact capability, input, target, likely effects and unsupported dry-run limits without performing the write. | Project creation UI previews its fields before the explicit create action. Universal sidecar preview/hash binding is not yet wired. |
| Authorize | Apply capability policy, role, scope and exact-input approval. Manual approval is the end-user default. | CapabilityBus and durable approvals enforce server-side policy. No general chat dispatcher currently consumes user chat messages as runs. |
| Execute | Call only registered typed capabilities through the trusted host and record progress. | Module capability calls and module-specific workflows exist. Generic chat execution is not connected. |
| Verify | Run the stated checks and persist source-linked results. A failed check cannot produce a completed task. | Forge evidence/gates and module verification flows exist; universal task completion gating is not connected to chat. |
| Resume or stop | Persist checkpoints, accept scoped steering as a new revision, and stop or resume only through a real executor. | FLOW has durable run checkpoints/claims; generic chat pause/resume and task-revision invalidation remain unconnected. |

## Approval modes

XIO's end-user default is **Preview & approve**. An action preview is read-only. Editing an input requires a new preview and invalidates any previous approval. Approval must be bound server-side to the authenticated actor, tenant/workspace, capability, input digest and expiry. The renderer is never the authority for approval.

An **Auto-approve** mode is a separate, explicit, durable user grant. It must show its workspace/task scope, eligibility, creation time and audit state; revocation blocks future actions. It cannot authorize consequential or high/critical actions, actions outside its scope, or newly introduced permissions. Restart must restore the persisted grant state. Until an eligible capability and the durable grant path are connected, the UI must say that no actions are eligible rather than imply automatic execution.

## Honest activity display

The interface may show verified lifecycle events such as `context loaded`, `preview ready`, `approval required`, `capability started`, `check passed`, and `blocked`. It must not display hidden chain-of-thought. When a stage is not connected, it must display that limitation and must not invent progress, output, approval or completion.

## Execution environments

Browser contexts, process sandboxes, local virtual machines and cloud virtual machines are distinct substrates. Selecting one never silently falls back to another. A browser context is not operating-system isolation. A substrate is selectable only after its adapter can enforce the requested scope, limits, lease, cancellation and cleanup behavior. Cloud compute additionally requires an explicitly configured provider and spending limits.
