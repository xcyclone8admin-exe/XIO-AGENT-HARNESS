# Governed chat task host: first connected slice

The host implements a bounded plan/action batch. It is a foundation for the complete task runtime, not evidence of iterative multi-agent execution, all product requirements, or release certification.

## Current path

1. An authenticated local user selects an available model and submits a conversation, instruction, logical connection ID and request UUID.
2. The host checks workspace membership and conversation access, commits an actor-scoped task, and persists the user instruction through the capability bus.
3. The trusted model port receives only the current authorized, agent-callable capability catalog. It proposes at most eight typed actions; model text supplies no identity, grants or approvals.
4. The host validates every proposal against that catalog and the registered input schema. Reads enter the ordinary capability bus. Writes wait for an exact preview.
5. Preview confirmation binds the authenticated actor, workspace, task revision, action, normalized input digest and fifteen-minute expiry. Stale, expired and concurrent duplicate confirmations fail. Consequential/high-risk capabilities still require their existing independent approval; ordinary confirmation cannot mint that proof.
6. Dispatch rechecks the current catalog and bus policy. Durable events record outputs and their digests. Completion means the bounded batch returned schema-validated capability outputs; it does not mean independent human review or semantic/release certification passed.

`brain.procedures.propose` is one supported agent-callable write. Its output remains a candidate awaiting review. Non-agent-callable capabilities cannot be made model tools merely by owning the workspace.

## Models and credentials

`TaskModelPort` is a trusted composition port. Public `ModelConnection` metadata contains no credential. The first built-in adapter discovers installed Ollama models at fixed `127.0.0.1:11434`, tests actual inference on request, and uses its local generate endpoint for a strict JSON plan. The renderer cannot choose an arbitrary URL or inject a key. Missing Ollama/models yields an empty available-model list and setup guidance. No model is downloaded automatically.

The selected connection ID is persisted with the task. Remote native/broker setup and an iterative agent-core adapter remain separate integration work. Controlled provider tests do not establish that an actual local model, paid provider or customer account is configured.

## State, pause and recovery

Task snapshots and append-only events use the local host migration sequence after the module baseline. `host_tasks` has an explicit server writer role; event updates/deletes are denied. Both tables enforce tenant/workspace RLS. The host checks actor ownership in addition to workspace scope. These records are local orchestration state, not a new cloud synchronization authority.

Admission replays the same actor/request UUID only for identical content. Revision changes preserve prior events and invalidate previous previews. Pause/cancel stops subsequent work and aborts cooperative model requests; an already started capability may finish and its outcome remains visible. Resume waits for the current operation to acknowledge stopping. Restart turns uncertain active work into `interrupted`; an uncertain write cannot be automatically replayed. Inspect/reconcile its external effect before starting replacement work.

The host limits concurrent batches to two, in-memory pending entries to one hundred, a batch to eight actions and an execution segment to two minutes. Existing capability handlers retain their own duration/cancellation behavior. The host cannot undo an already committed side effect. A response or output-validation failure can occur after that effect; failure is not proof that nothing happened.

## Entry points and evidence boundaries

The task API is mounted behind the existing loopback Host, Origin and launch-token checks. `GET /api/v1/models`, `POST /api/v1/models/test`, task list/get, and task admit/approve/control routes derive identity on the server and parse strict bodies. The SDK validates response schemas; the chat UI displays persisted task progress, exact proposals, outputs and controls.

Integration tests use the real sidecar, migrations, PGlite and capability handlers with a controlled model port. They check read/write consent, changed/stale/duplicate input, restart/replay and forbidden tools. The host-store tests exercise upgrade, app-role write denial, event immutability, actor/workspace isolation, expiry, revision invalidation and refusal to resume an uncertain write. The browser journey checks visible consent before a persisted candidate and reload persistence. None of these tests certify a live provider, native installer, process/browser isolation, full accessibility or complete XYRA lifecycle.

Remaining work includes actual tool-result continuation and outcome verification, secure remote onboarding, durable scoped auto-approval/revocation, trusted Command result-message delivery, multi-agent teams, richer project/requirements binding, computer tools and the full release gates. The previous `cb06327` handoff remains unchanged.
