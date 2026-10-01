# XIO product direction

This document records the user's requested product behavior on October 1, 2026. It is an implementation target, not a claim that all features are delivered.

## Identity and workspaces

The application is **XIO**. XYRA names its underlying operating process. Preserve existing internal identifiers, database paths, credential names and upgrade identity unless a deliberate migration is implemented.

Consolidate navigation into Chat, Projects, World and Library, with Settings as a utility destination. This grouping is the current implementation proposal. Keep existing module deep links and contextual tools. Launch should support starting a task, resuming work, or opening/creating a project.

## Universal text and voice chat

Chat is the natural-language control surface for all registered program tools. It discovers and routes typed capabilities through existing identity, workspace, permission, approval and audit controls. It must not expose unrestricted SQL, shell execution or secret-bearing native IPC.

Provide persistent threads, agent/model selection, progress and tool outputs, editable mid-task instructions and explicit pause/resume/cancel acknowledgements. Selecting a model should use configured connections; adding a provider belongs in secure settings.

Proposed voice baseline: visible push-to-talk recording, stop control, editable transcript before send, optional spoken replies, clear permission/error states. A microphone button without a working supported native/browser path is not completion.

## Visual direction

Primarily black/charcoal with red accents and readable neutral text. Add persistent selectable themes. Keep status and keyboard focus understandable without relying only on color. Respect reduced motion.

World should use original modern robotic, pixel-inspired artwork and reflect actual agents/projects/tasks. Selecting something opens its conversation or inspector. The precise pixel-art reference repository remains unconfirmed; restricted source artwork must not be copied.

## Default XYRA operating process

Resolve project context, understand/classify, plan proportionately, execute authorized capabilities, verify outcomes, and record evidence/checkpoints. Small actions stay lightweight. Larger work retains requirements, review and durable progress. Failed verification must prevent a completed claim. Scope changes and restart/resume are visible and tested.

The required runtime process definitions must ship with the product; a clone or installed app must not depend on the original machine's XYRA-MASTER directory. Prompt text alone is not enforcement.

## Preview and approval

Default to Preview & approve. Show drafts, diffs, rendered outputs or an honest summary of proposed effects before committing actions. Never mutate merely to manufacture a preview. Read-only discovery can prepare it without an approval loop.

Bind approval to exact inputs/version and scope. Edits invalidate approval. Auto-approve is a visible, scoped, revocable product-user grant with durable audit. It does not create missing permissions or bypass technical controls. Disabling it stops future automatic approvals and reports in-flight work accurately.

## Desktop menus

Provide native File, Edit, View, Window and Help menus in a familiar desktop pattern. Only expose supported working commands. Use focused-editor native edit actions and consistent accelerators; avoid chat/voice shortcut conflicts. Menu-triggered consequential actions follow the same approval system.

## Browser and virtual computers

The user selected **both local and cloud virtual computers**, selectable per task. Implement real lifecycle adapters, resource/time limits, artifact transfer, stop/cleanup, visible cost controls and configured cloud budgets. Windows 11 Home on the build machine means Windows Sandbox/Hyper-V cannot be assumed.

Agent browser sessions should provide visible pages/tabs, navigation, DOM/accessibility-oriented actions, screenshots when useful, downloads, watch/takeover and pause/cancel. Reuse consented task sessions and bound parallelism. Treat web content as untrusted input. BrowserContext isolation is not OS/VM isolation.

Backend/provider selection and physical isolation evidence remain open engineering work. Do not label unavailable adapters operational or claim Polar performance parity without measurements.

## Delivery acceptance

Demonstrate connected user journeys, not inert controls: chat→tool→preview→approval→verified effect; revision/cancel/resume; voice transcription; configured-model routing; theme persistence; World→chat/project; native menu dispatch; browser takeover/cleanup; supported local/cloud VM lifecycle and failure modes. Verify isolation and approval revocation.

Only then rebuild the installer and create the final ZIP with the matching complete source, install/development instructions, architecture and remaining limitations. The earlier installer is a separate pre-redesign development build.
