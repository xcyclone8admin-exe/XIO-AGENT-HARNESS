//! Local execution broker boundary (WP-EXEC, XIO-REQ-CMP-001 / XIO-REQ-FRG-004 /
//! XIO-REQ-FRG-011 / REQ-AIS-002 / REQ-AIS-005 / REQ-DATA-001).
//!
//! This module is production-shaped but inert: the only wired [`gate::NativeAuthorizationVerifier`]
//! is [`gate::ClosedVerifier`], which refuses every token, so [`broker::ExecutionBroker::submit`]
//! built with [`broker::ExecutionBroker::new`] can never reach a real process launch. See
//! `gate.rs` for why that is the correct fail-closed behaviour for the C1 phase, and
//! `../../../../../../execution/tasks/active/WP-EXEC.yaml` for the task contract this module
//! implements.
//!
//! Capabilities that still require C1 authorization and separate deployment work before this
//! module can execute anything:
//! - Minting a [`gate::C1Authorization`] from a real native approval flow (no verifier exists).
//! - Restricted-token creation for a child process ([`capability::IsolationCapability::RestrictedToken`]
//!   is unconditionally reported unavailable today).
//! - Wiring [`broker::ExecutionBroker`] into `commands.rs`/`lib.rs` and the WebView IPC surface.
//! - Actually calling `Command::spawn` on an [`broker::AuthorizedPlan`] with a timeout/cancel
//!   watchdog and bounded-output capture — `build_command` only constructs the `Command`.

// `pub(crate)` for now: nothing outside this module calls into the broker yet (see module docs
// for what still has to happen before `commands.rs`/`lib.rs` wires it up). Switch to `pub` and
// re-export the public surface once a caller exists, so an unused-import warning here keeps
// flagging the gap instead of being silenced by a re-export no one has used yet.
pub(crate) mod audit;
pub(crate) mod broker;
pub(crate) mod capability;
pub(crate) mod gate;
pub(crate) mod request;
