# XIO — additions and next Traycer pickup

**Read this first when continuing the handoff.** Updated October 1, 2026. This file preserves the user's recent requests and unfinished implementation. It is not a list of completed features.

## Latest delivery decision

The user requested: "for now just create the handoff with the last things ive said to add in an additions markdown file for the next traycer to pick up". Package the current implemented build with installer, source/history, installation and architecture documentation. This supersedes the earlier instruction to wait for all additions before making the ZIP. Do not spend the handoff phase silently implementing a different product or claim the remaining work is finished.

Repository: https://github.com/xcyclone8admin-exe/XIO-AGENT-HARNESS . It is **public**, explicitly authorized by the user. Default branch: `development`. Normal non-force updates are authorized as work finishes. Preserve Git history, third-party notices and the user's ownership. Public visibility does not introduce a new blanket software license.

The handoff's `MANIFEST.json` identifies the exact source commit, installer provenance and verification evidence. Use that file rather than assuming a later GitHub tip is the installed version.

## Implemented starting point

- Sixteen modules: core, command, ops, comms, corporate, brain, swarm, forge, flow, connect, data, growth, studio, intel, money and invest.
- Windows Tauri shell, supervised Node sidecar, typed capability bus, PGlite/RLS, native authentication boundaries and an unsigned NSIS packaging path.
- UI feature commit `cd8a0c1505e7081fadd444af94b8b4959c841e77`, published with prior documentation at `690e18a240078a5c4c266dc5d772e9daf93eadbf`: Chat/Projects/World/Library, persisted messages, red-default themes, project preview/create, scoped Library reads and a module/dependency World graph.
- The UI checkpoint passed root verification (430 tests/64 files, typecheck/lint, checks 577 files), 66-page web export, and two Playwright journeys. That is limited workflow evidence, not complete accessibility or product certification.
- General messages are stored through Command capabilities. **Saving a message does not yet execute an agent task.** Profile preferences do not provision model credentials. World is a module graph, not the completed interactive agent world.
- Earlier native/installer baseline `148c6a2` had 88 Rust tests and install/launch/same-version-reinstall/uninstall evidence. Treat those as earlier evidence unless the handoff manifest records a fresh run.

## Priority 1 — real universal agent chat

User intent: people should control the whole program through agent conversations, using text or voice, with their chosen model and mid-task steering, similar to the working pattern of Traycer.

Build a trusted dispatcher connecting conversation/task revisions to SWARM runs and all eligible registered capabilities. Derive principal/workspace server-side, preserve authorization/audit, and use actual provider results. Do not expose arbitrary SQL, unrestricted shell commands or secret-bearing native routes as chat tools.

Required behavior:

- Select a configured agent and model in the conversation; securely add providers/models in settings.
- Persist task/run association, progress, outputs, errors and evidence; distinguish queued, running, paused, failed, cancelled and completed states.
- Mid-task edits become explicit revisions/follow-ups with received/applied acknowledgement. Invalidate stale approvals when inputs change.
- Pause/resume/cancel reach the real executor. Resume after application restart from durable state.
- Model-generated tool calls are untrusted; validate every call through the same capability/policy layer as UI workflows.

Acceptance: a real configured model performs a scoped read and a previewed/approved write, reports the verified effect, accepts steering, cancels safely and resumes a saved task. Unavailable models/tools show honest errors, never canned successful agent replies.

Likely integration areas: `apps/web/src/app/chat-workspace.tsx`, `modules/command`, `modules/swarm`, `packages/agent-core`, `apps/sidecar`, `packages/sdk` and shared contracts. Keep module-private services behind host-injected public ports.

## Priority 2 — previews and approval modes

User intent: previews for actions, approval before acting, and a visible automatic approval mode/button.

The current project-create preview is a UI flow only. Implement a general trusted preview record bound to exact capability/input digest, scope, actor, version and expiry. Show a diff, draft, rendered preview or honest action summary; declare unsupported simulation. Never execute merely to create a preview.

Manual Preview & approve is the product default. Auto-approve is a deliberate scoped user grant with durable audit, clear eligible actions, pause/revoke controls, and accurate in-flight status. It must not create permissions or bypass technical controls. Editing a request invalidates the prior approval. Preserve the existing capability approval boundary rather than trusting a renderer flag.

Acceptance: no mutation before manual approval; changed-input refusal; only in-scope automatic execution; revocation blocks future automatic actions; restart retains the correct policy and audit. Test concurrent requests and exact replay.

## Priority 3 — portable XYRA operating logic

XYRA is the default operating process inside XIO, not merely how the original team developed it. `docs/xyra-process.md` currently describes intended stages and gaps.

Implement durable context → understand/classify → proportionate plan → preview/authorize → execute → verify → checkpoint/resume. Small tasks should stay lightweight. Larger builds retain requirement/evidence traceability and applicable independent review. A failed check cannot become completed just because the model says it is.

Package versioned definitions with the app. Do not require the original machine's `XYRA-MASTER` folder or embed its secrets. Test a simple task, multistage build, changed scope, failed verification and restart/resume.

## Priority 4 — voice and model onboarding

Browser speech API availability is currently only a partial foundation. Provide a reliable supported desktop text/voice path with microphone permission, visible recording/stop, editable transcript before send, cancellation/error handling, and optional spoken replies. Keep text usable when voice is unavailable.

Credential entry belongs in a secure native/broker/settings flow. Keep keys out of messages, localStorage, renderer responses, logs and screenshots. Verify actual selected-provider/model routing; a saved label is not connected model support. Declare whether any speech audio leaves the machine.

## Priority 5 — XIO design, World and menus

The final user-facing name is **XIO**. Keep internal app identifiers, data paths and credential names stable unless deliberately migrated. Complete native window titles, installer display/filename, shortcuts and About branding without orphaning user data.

Retain mainly black/charcoal and red accents with persistent themes, contained panels, progress and editable work. Four overarching spaces already exist; keep specialized module routes accessible contextually instead of multiplying top-level tabs.

World should become an original modern robotic, pixel-inspired environment reflecting real agents/projects/tasks — the user said more "Ultron" than "Jarvis". The intended reference repo was not conclusively identified. Do not copy restricted starnet artwork or claim the current solar graph satisfies the complete request. Selecting an agent should open its chat/inspector; empty/offline states must be honest.

Finish native **File / Edit / View / Window / Help** menus in a familiar desktop pattern. Frontend event handlers exist; native integration and installed-app tests remain. Only expose working actions. Edit actions target the focused editor; shortcuts must not conflict with chat/voice. Preserve approval boundaries for menu-triggered writes.

Acceptance: installed-app menu dispatch, focus/shortcuts, theme persistence, readable contrast/keyboard navigation/reduced motion, and World-to-real-task/chat navigation. Add broader browser and accessibility coverage beyond the current two journeys.

## Priority 6 — internal browser and virtual computers

The user explicitly chose **both local and cloud VMs**, selectable per task. They also requested agent-controlled internal browsing with Playwright-like functions and efficiency inspired by Polar Browser.

No XIO-owned browser/VM backend was implemented in the current milestone. WSL/Docker presence is not an adapter. The original host is Windows 11 Home; do not assume Windows Sandbox/Hyper-V availability. Determine supported local and cloud providers through actual capability probes and configuration.

Implement distinct substrate adapters with typed create/connect/status/stop/destroy operations, isolation, resource/time limits, cancellation, artifact transfer, recovery and cleanup. Cloud compute needs a configured account and spending limits; do not invent an unlimited budget. Never silently substitute a browser context for an OS VM.

Browser sessions need task-scoped tabs/profiles, DOM/accessibility actions, screenshots when needed, navigation/download controls, human watch/takeover and pause/stop. Prefer reusable sessions and bounded parallelism; measure efficiency instead of claiming Polar parity. Untrusted page content cannot issue privileged application instructions or access secret-bearing IPC.

Acceptance: real local and cloud lifecycle with cleanup and failure recovery; real browser workflows and takeover; hostile-page boundary tests; cost/time enforcement. If infrastructure is unavailable, show it as unavailable and preserve the remaining requirement.

## Existing product work that must not be lost

| Area | Remaining implementation or evidence |
|---|---|
| FORGE / SWARM | Prepared review admission → real bounded run → immutable result-sink delivery; human validation remains separate from agent drafts |
| FLOW / INVEST custody | Actual timer/dispatch and configured custody provider; current claims, handlers and receipts are foundations |
| BRAIN / Cloud | Complete authenticated ingestion/reference/erasure journeys; authoritative refs, holds, shared retention and no-resurrection evidence |
| Cloud / Desktop auth | Real enrolled passkey/device session/refresh/signed-signal claim and acknowledgement; synthetic local tests are not live user proof |
| R2 | Original account returned provider error 10042 pending activation; no deletion or blob-storage success may be fabricated |
| Native device and execution | Physical TPM proof; production runner verifier, restricted-token/isolation/watchdog/output paths and escape tests |
| Other domain modules | Remaining Corporate/Studio writes/provenance, connector adapters, external data and cross-module journeys; check module READMEs/contracts rather than inferring completion from registration |
| Release | Genuine version-to-version upgrade, clean-machine install, full accessibility/security/data/AI/requirements evidence and Gauntlet reconciliation |

MONEY/INVEST stays **PAPER-only**. No live trading was requested. Existing development Cloud deployment does not authorize a production deployment. An unsigned continuation installer is acceptable; do not invent a new signing-certificate blocker.

## Authorization and honest reporting

The user repeatedly authorized routine work without repeated confirmation, including brokered use of the registered Cloudflare credential, and explicitly made this source repository public. Carry that authorization forward for this scope. It does not create missing credentials/hardware or remove technical security controls. Developer standing approval does not change the product's manual approval default for new users.

Do not paste secrets into chat, copy vaults into the handoff, or use privileged migration credentials as runtime credentials. On a different machine, restore the user's authorized secure bindings; no secret values are supplied in the package.

Do not report a completion percentage from test counts. The factory requirement map had unreconciled PENDING records despite implementation; reconcile each item against actual code and exact-candidate evidence rather than setting all to PASS. Preserve limitations in README/status and keep GitHub current.

## Resume checklist for the next Traycer

1. Verify the handoff checksums and source commit from `MANIFEST.json`; read README, this file, architecture, setup, status and security docs.
2. Clone the public repo (or restore the included Git bundle) and use an isolated branch/worktree. Do not reinitialize or overwrite source history.
3. Restore dependencies with `npm ci`, generate registries, and run the documented checks. Browser tests require the current static export. Keep validation evidence tied to the exact tree being packaged.
4. Inventory actual provider/device/browser/VM support and secure credentials on the destination system. Distinguish unavailable infrastructure from unimplemented code.
5. Continue connected universal chat and trusted approval/XYRA execution first, then the remaining additions above. Use bounded owned scopes if delegating; avoid duplicate agents editing shared files.
6. Update GitHub `development` normally as coherent verified slices finish. Never force-push away other work. Update these status documents and preserve the old handoff for provenance.
7. Build the next installer/source ZIP from one frozen candidate and record hashes/tests. Call it a release only when its applicable gates pass.

## Ready-to-send continuation prompt

> Continue XIO Agent Harness from this handoff. Read ADDITIONS.md and MANIFEST.json first. Preserve the implemented 16-module baseline and current chat/theme/workspace UI. Finish the connected universal agent chat, trusted preview/auto-approval and portable XYRA runtime, then voice/model onboarding, native XIO menus/World, browser automation and both local/cloud VM adapters. Assume the user's existing in-scope approvals, retain security and PAPER-only boundaries, and do not fabricate unavailable infrastructure or completed evidence. Keep GitHub and the status docs updated and rebuild matching installer/source deliverables when verified.
