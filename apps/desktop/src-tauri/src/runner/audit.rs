//! Deterministic audit receipts for every invocation the broker handles (REQ-DATA-001).
//!
//! Every call into `ExecutionBroker::submit` or `cancel` produces exactly one receipt, success or
//! denial. Nothing here persists the receipt — that is the trusted host's job once it wires this
//! module in — but the shape is fixed now so the host has a stable, serializable record to log.

use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DenialReason {
    InvalidRequest,
    GateClosed,
    /// Reserved for when `ExecutionBroker::cancel` can target a run genuinely in flight; today
    /// every run is denied before it starts, so `cancel` always reports `NoActiveRun` instead.
    #[allow(dead_code)]
    CancelledByCaller,
    NoActiveRun,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Denial {
    pub reason: DenialReason,
    pub detail: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum AuditOutcome {
    Denied(Denial),
    /// The request passed every policy check and the gate was open. No run in this build ever
    /// reaches this variant today because the only wired verifier never opens the gate (see
    /// `gate.rs`); it exists so the receipt shape does not need to change when one does.
    Authorized { token_id: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditReceipt {
    pub run_id: String,
    pub recorded_at_ms: u64,
    pub outcome: AuditOutcome,
}

impl AuditReceipt {
    pub fn denied(run_id: impl Into<String>, recorded_at_ms: u64, denial: Denial) -> Self {
        Self {
            run_id: run_id.into(),
            recorded_at_ms,
            outcome: AuditOutcome::Denied(denial),
        }
    }

    pub fn authorized(run_id: impl Into<String>, recorded_at_ms: u64, token_id: String) -> Self {
        Self {
            run_id: run_id.into(),
            recorded_at_ms,
            outcome: AuditOutcome::Authorized { token_id },
        }
    }

    pub fn is_denied(&self) -> bool {
        matches!(self.outcome, AuditOutcome::Denied(_))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_denial_receipt_serializes_the_reason_and_detail() {
        let receipt = AuditReceipt::denied(
            "run-1",
            1_000,
            Denial {
                reason: DenialReason::GateClosed,
                detail: "C1 keeps the execution substrate disabled".into(),
            },
        );
        assert!(receipt.is_denied());
        let json = serde_json::to_string(&receipt).unwrap();
        assert!(json.contains("\"runId\":\"run-1\""));
        assert!(json.contains("\"outcome\":\"denied\""));
        assert!(json.contains("\"reason\":\"GATE_CLOSED\""));
    }

    #[test]
    fn an_authorized_receipt_is_not_a_denial() {
        let receipt = AuditReceipt::authorized("run-1", 1_000, "token-1".into());
        assert!(!receipt.is_denied());
    }
}
