# Active XIO completion wave

October 14, 2026. The user explicitly requested implementation of all new requirements using multiple agents and workflows. This lifts the earlier handoff-only freeze. The [complete product specification](complete-product-spec.md), [business/ads/funnel specification](business-ads-requirements.md) and [ADDITIONS](../ADDITIONS.md) remain the target; the first connected slice does not narrow it.

## Starting point and ownership

The wave starts from public `development` at `4a4fb2507445de1224bff0f1df56a6966483713b`. The previous HANDOFF installer/source at `cb06327` remains unchanged. Root contracts, registry and dependencies have one integration owner; module workers use isolated worktrees and public injected interfaces.

| Lane | Owned implementation | First exit gate |
|---|---|---|
| Host | Sidecar, web shell, shared contracts/SDK/UI, integration | Selected model performs scoped read and preview-confirmed write, with verified persisted result and restart recovery. |
| Agent runtime | Agent core and SWARM | Bounded model/tool continuation, durable claims, cancellation, steering and team/reviewer results. |
| Command and Growth | Command, Comms, Growth | Chat/task persistence port first; then editable web/funnel/email and Meta/Google lifecycles. |
| Desktop/computers | Native setup/menu/credentials and computer adapters | Secure provider setup; internal browser and separate local/cloud VM lifecycle evidence. |
| Secure runner | Native runner directory | Actual authorization, enforced isolation, bounded spawn/output, watchdog and cleanup; unsupported configurations refuse. |
| Business/legal | Corporate and Studio | Business intake plus versioned legal drafts, edit/redline/review and rendered exports. |
| Connections/schedules | CONNECT and FLOW | Real scoped MCP transport and durable due-run dispatch/recovery. |

Preserve the project's three-concurrent-Claude limit. First active batch is Host, Agent runtime and Command/Growth. Rotate a slot after the Command seam to native provider setup and after a bounded runtime candidate to independent review. Queue other independent slices as ports become available. Reviewers do not author the code they assess. No agent may wake additional workers beyond the cap without coordinator scheduling.

## Connected acceptance

The first shared contract checkpoint is `3bb5108`: strict task admission, revisions, previews, provider metadata and a trusted model port. Its contract typecheck/lint passed; this is not evidence of completed chat execution.

Every completed workflow must bind conversation/task revision to actual execution, capability authorization, durable progress/artifacts and a verified result. Model responses, tool catalogs and UI availability never confer authority. Show waiting, failed, partially completed and unavailable states accurately.

Preserve current independent approval requirements for consequential actions. Policy-eligible ordinary writes need exact preview confirmation; scoped automatic policies cannot override capability restrictions. Changed scope/input/revision invalidates an earlier decision. Model/capability execution is separate from the native-process isolation gate.

Test actual database and UI paths, plus stale preview, forged scope, replay, duplicate claim, lost reply, cancellation, revocation and restart. Distinguish deterministic provider fixtures from real account/VM/hardware results. Before release, run all applicable gates against one frozen integrated source and matching installer, reconcile every new and retained requirement, and preserve the previous handoff until the replacement verifies.

## External prerequisites and retained scope

Provider account access, verified domains/senders, authorized recipients, paid resource budgets, available local virtualization, R2 activation and physical passkey/TPM evidence are concrete setup or verification dependencies. They do not block unrelated implementation. Do not invent those facts or mark their live journeys passed from mocks.

Application data stays within the existing local/Neon/Cloudflare/R2 architecture. Model, MCP, business-service and VM providers are scoped integrations. Preserve PAPER-only investment behavior. Normal public development-source updates are authorized; production release and unbounded customer-account spending are not implied.

The canonical factory control plane records BUILD_CONTRACT v4, REQUIREMENTS_MAP v8 (41 additive acceptance rows), the actual owner tree and bounded task contracts. Standalone clones can use this document and the checked-in specifications without requiring the original machine's factory path.
