//! The execution broker: the single place a trusted host would call to submit or cancel an
//! invocation (XIO-REQ-CMP-001, XIO-REQ-FRG-004, XIO-REQ-FRG-011, REQ-AIS-002, REQ-AIS-005,
//! REQ-DATA-001).
//!
//! `submit` always runs in the same order: parse the raw request strictly, then resolve the C1
//! gate. Nothing between those two steps and a real `Command` touches the process API — the gate
//! check happens before any isolation-capability probe or command construction, so a closed gate
//! (today, always) guarantees no process is ever created. A denial is still a receipt, not a
//! `Result::Err` escape hatch the caller can forget to log: both branches of `submit` return an
//! `AuditReceipt` alongside whatever the caller needs next.

use std::time::{SystemTime, UNIX_EPOCH};

use crate::runner::audit::{AuditReceipt, Denial, DenialReason};
use crate::runner::capability::{self, IsolationCapability};
use crate::runner::gate::{C1Gate, ClosedVerifier, NativeAuthorizationVerifier};
use crate::runner::request::{InvocationRequest, RawInvocationRequest, RequestError};
use crate::spawn_scoped::{self, ScopedSpawnError};

/// Everything resolved and ready to hand to the OS once a run is authorized. Building this struct
/// never spawns a process; see `broker::tests` for coverage that stops exactly here.
pub struct AuthorizedPlan {
    pub run_id: String,
    pub command: std::process::Command,
    pub required_isolation: Vec<IsolationCapability>,
}

pub enum SubmitOutcome {
    Denied,
    Authorized(AuthorizedPlan),
}

pub struct ExecutionBroker {
    allow_listed_programs: Vec<String>,
    verifier: Box<dyn NativeAuthorizationVerifier + Send + Sync>,
}

impl ExecutionBroker {
    /// The production constructor: the only verifier wired in is `ClosedVerifier`, so `submit`
    /// can never return `SubmitOutcome::Authorized` from a broker built this way.
    pub fn new(allow_listed_programs: Vec<String>) -> Self {
        Self {
            allow_listed_programs,
            verifier: Box::new(ClosedVerifier),
        }
    }

    /// Test-only seam for exercising the authorized path without ever wiring a real verifier into
    /// production code.
    #[cfg(test)]
    pub fn with_verifier(
        allow_listed_programs: Vec<String>,
        verifier: Box<dyn NativeAuthorizationVerifier + Send + Sync>,
    ) -> Self {
        Self {
            allow_listed_programs,
            verifier,
        }
    }

    pub fn submit(
        &self,
        raw: RawInvocationRequest,
        raw_token: Option<&str>,
    ) -> (AuditReceipt, SubmitOutcome) {
        let now = now_ms();
        let run_id_for_parse_failure = raw.run_id.clone();

        let request = match InvocationRequest::parse(raw, &self.allow_listed_programs) {
            Ok(request) => request,
            Err(err) => {
                return (
                    AuditReceipt::denied(
                        run_id_for_parse_failure,
                        now,
                        Denial {
                            reason: DenialReason::InvalidRequest,
                            detail: format_request_error(&err),
                        },
                    ),
                    SubmitOutcome::Denied,
                )
            }
        };

        let gate = C1Gate::resolve(raw_token, now, self.verifier.as_ref());
        let C1Gate::Authorized(authorization) = gate else {
            return (
                AuditReceipt::denied(
                    request.run_id,
                    now,
                    Denial {
                        reason: DenialReason::GateClosed,
                        detail:
                            "C1 keeps the execution substrate disabled; refused before any process was created"
                                .to_string(),
                    },
                ),
                SubmitOutcome::Denied,
            );
        };

        let required_isolation = vec![IsolationCapability::JobObjectKillOnClose];
        let reports = capability::detect_all();
        if !capability::all_available(&reports, &required_isolation) {
            return (
                AuditReceipt::denied(
                    request.run_id,
                    now,
                    Denial {
                        reason: DenialReason::GateClosed,
                        detail: "required isolation capability is unavailable on this host"
                            .to_string(),
                    },
                ),
                SubmitOutcome::Denied,
            );
        }

        let command = match build_command(&request) {
            Ok(command) => command,
            Err(err) => {
                return (
                    AuditReceipt::denied(
                        request.run_id,
                        now,
                        Denial {
                            reason: DenialReason::InvalidRequest,
                            detail: err.to_string(),
                        },
                    ),
                    SubmitOutcome::Denied,
                )
            }
        };

        (
            AuditReceipt::authorized(request.run_id.clone(), now, authorization.token_id),
            SubmitOutcome::Authorized(AuthorizedPlan {
                run_id: request.run_id,
                command,
                required_isolation,
            }),
        )
    }

    /// There is no run tracking in this phase (no run can ever start), so cancel always reports
    /// `NoActiveRun`. The method exists so the host has a stable call it can wire up today and the
    /// receipt shape it will keep once runs exist.
    pub fn cancel(&self, run_id: &str) -> AuditReceipt {
        AuditReceipt::denied(
            run_id.to_string(),
            now_ms(),
            Denial {
                reason: DenialReason::NoActiveRun,
                detail: "no run is active for this run id".to_string(),
            },
        )
    }
}

fn build_command(request: &InvocationRequest) -> Result<std::process::Command, ScopedSpawnError> {
    let program = std::path::Path::new(&request.target.program);
    let args: Vec<std::ffi::OsString> = request
        .target
        .args
        .iter()
        .map(std::ffi::OsString::from)
        .collect();
    let explicit: Vec<(&str, String)> = request
        .env
        .iter()
        .map(|(name, value)| (name.as_str(), value.clone()))
        .collect();
    let mut command = spawn_scoped::scoped_command(program, &args, &explicit, &|_| false)?;
    command.current_dir(&request.cwd);
    Ok(command)
}

fn format_request_error(err: &RequestError) -> String {
    err.to_string()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::gate::{C1Authorization, GateError};

    fn raw(program: &str) -> RawInvocationRequest {
        RawInvocationRequest {
            run_id: "run-1".into(),
            workspace_root: std::env::temp_dir(),
            cwd: std::env::temp_dir(),
            program: program.into(),
            args: vec!["--version".into()],
            env: vec![],
            timeout_ms: 5_000,
            max_output_bytes: 1024,
        }
    }

    struct AlwaysAuthorizes;
    impl NativeAuthorizationVerifier for AlwaysAuthorizes {
        fn verify(&self, _raw_token: &str, now_ms: u64) -> Result<C1Authorization, GateError> {
            Ok(C1Authorization {
                token_id: "test-token".into(),
                issued_at_ms: now_ms,
                expires_at_ms: now_ms + 60_000,
            })
        }
    }

    #[test]
    fn a_malformed_request_is_denied_before_the_gate_is_even_checked() {
        let broker = ExecutionBroker::new(vec!["node.exe".into()]);
        let (receipt, outcome) = broker.submit(raw("not-allow-listed.exe"), Some("irrelevant"));
        assert!(receipt.is_denied());
        assert!(matches!(outcome, SubmitOutcome::Denied));
    }

    #[test]
    fn the_production_broker_never_authorizes_even_with_a_token_supplied() {
        let broker = ExecutionBroker::new(vec!["node.exe".into()]);
        let (receipt, outcome) = broker.submit(raw("node.exe"), Some("some-token"));
        assert!(receipt.is_denied());
        assert!(matches!(outcome, SubmitOutcome::Denied));
    }

    #[test]
    fn the_production_broker_denies_with_no_token_at_all() {
        let broker = ExecutionBroker::new(vec!["node.exe".into()]);
        let (receipt, outcome) = broker.submit(raw("node.exe"), None);
        assert!(receipt.is_denied());
        assert!(matches!(outcome, SubmitOutcome::Denied));
    }

    #[test]
    fn an_authorized_gate_with_available_isolation_builds_a_plan_without_spawning() {
        let broker = ExecutionBroker::with_verifier(
            vec!["node.exe".into()],
            Box::new(AlwaysAuthorizes),
        );
        let (receipt, outcome) = broker.submit(raw("node.exe"), Some("token"));
        assert!(!receipt.is_denied());
        match outcome {
            SubmitOutcome::Authorized(plan) => {
                assert_eq!(plan.run_id, "run-1");
                assert_eq!(
                    plan.required_isolation,
                    vec![IsolationCapability::JobObjectKillOnClose]
                );
                assert_eq!(plan.command.get_program(), "node.exe");
                let args: Vec<_> = plan.command.get_args().collect();
                assert_eq!(args, vec!["--version"]);
                assert_eq!(
                    plan.command.get_current_dir(),
                    Some(std::env::temp_dir().as_path())
                );
                // Building the plan never calls Command::spawn; nothing here asserts a process ran.
            }
            SubmitOutcome::Denied => panic!("expected an authorized plan"),
        }
    }

    #[test]
    fn cancel_always_reports_no_active_run_because_no_run_can_ever_start() {
        let broker = ExecutionBroker::new(vec!["node.exe".into()]);
        let receipt = broker.cancel("run-1");
        assert!(receipt.is_denied());
        assert_eq!(receipt.run_id, "run-1");
    }

    #[test]
    fn a_denied_request_never_produces_an_authorized_outcome_regardless_of_gate_state() {
        let broker = ExecutionBroker::with_verifier(
            vec!["node.exe".into()],
            Box::new(AlwaysAuthorizes),
        );
        let (receipt, outcome) = broker.submit(raw("not-allow-listed.exe"), Some("token"));
        assert!(receipt.is_denied());
        assert!(matches!(outcome, SubmitOutcome::Denied));
    }
}
