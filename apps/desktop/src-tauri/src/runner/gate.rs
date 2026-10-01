//! The C1 execution gate (XIO-REQ-FRG-011, REQ-AIS-005).
//!
//! `modules/forge/contracts.ts`'s `SchedulerConfig` keeps `substrateVerified` and
//! `externalAdaptersEnabled` false for the C1 phase: "C1 keeps execution substrate and external
//! adapters disabled". This module is the runner-side half of that same rule. There is
//! deliberately no code path in this crate that can mint a `C1Authorization` today —
//! `ClosedVerifier` is the only verifier anything wires up, and it always refuses. The trait and
//! the `Authorized` branch exist so the broker is shaped for the day a real native verifier is
//! approved and wired in, without this file needing to change.
//!
//! Fail-closed is the only acceptable failure mode here: a missing token, a token a verifier
//! can't parse, and a verifier error all collapse to the same `Closed` result as no token at all.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct C1Authorization {
    pub token_id: String,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum C1Gate {
    Closed { reason: &'static str },
    Authorized(C1Authorization),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GateError {
    /// No verifier implemented today returns this; `C1Gate::resolve` already short-circuits a
    /// missing token before calling the verifier. Reserved for a future verifier's own use.
    #[allow(dead_code)]
    MissingToken,
    MalformedToken,
    /// Reserved for a future verifier that can detect expiry itself; `resolve` currently checks
    /// expiry on the returned `C1Authorization` instead of requiring the verifier to.
    #[allow(dead_code)]
    Expired,
    VerifierRejected,
}

/// The boundary a trusted native host would implement once C1 is authorized. Nothing in this
/// crate implements it with a real signature check yet; see module docs.
pub trait NativeAuthorizationVerifier {
    fn verify(&self, raw_token: &str, now_ms: u64) -> Result<C1Authorization, GateError>;
}

/// The only verifier wired up today. It refuses every token unconditionally, which is what keeps
/// C1 closed regardless of what a caller supplies.
pub struct ClosedVerifier;

impl NativeAuthorizationVerifier for ClosedVerifier {
    fn verify(&self, _raw_token: &str, _now_ms: u64) -> Result<C1Authorization, GateError> {
        Err(GateError::VerifierRejected)
    }
}

pub const CLOSED: C1Gate = C1Gate::Closed {
    reason: "C1 keeps the execution substrate disabled; no process may be created",
};

impl C1Gate {
    /// Resolve the gate state for one request. Any of "no token", "verifier error", or "token
    /// expired by `now_ms`" fails closed; only a verifier that both accepts the token and reports
    /// an expiry strictly after `now_ms` can open the gate.
    pub fn resolve(
        raw_token: Option<&str>,
        now_ms: u64,
        verifier: &dyn NativeAuthorizationVerifier,
    ) -> C1Gate {
        let Some(raw) = raw_token else {
            return CLOSED;
        };
        match verifier.verify(raw, now_ms) {
            Ok(auth) if auth.expires_at_ms > now_ms => C1Gate::Authorized(auth),
            _ => CLOSED,
        }
    }

    pub fn is_open(&self) -> bool {
        matches!(self, C1Gate::Authorized(_))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_token_closes_the_gate() {
        let gate = C1Gate::resolve(None, 1_000, &ClosedVerifier);
        assert!(!gate.is_open());
        assert_eq!(gate, CLOSED);
    }

    #[test]
    fn the_production_verifier_refuses_every_token() {
        let gate = C1Gate::resolve(Some("anything-at-all"), 1_000, &ClosedVerifier);
        assert!(!gate.is_open());
    }

    struct StubVerifier {
        result: Result<C1Authorization, GateError>,
    }
    impl NativeAuthorizationVerifier for StubVerifier {
        fn verify(&self, _raw_token: &str, _now_ms: u64) -> Result<C1Authorization, GateError> {
            self.result.clone()
        }
    }

    #[test]
    fn a_malformed_token_closes_the_gate() {
        let verifier = StubVerifier {
            result: Err(GateError::MalformedToken),
        };
        let gate = C1Gate::resolve(Some("garbage"), 1_000, &verifier);
        assert!(!gate.is_open());
        assert_eq!(gate, CLOSED);
    }

    #[test]
    fn an_already_expired_authorization_closes_the_gate() {
        let verifier = StubVerifier {
            result: Ok(C1Authorization {
                token_id: "t1".into(),
                issued_at_ms: 0,
                expires_at_ms: 500,
            }),
        };
        let gate = C1Gate::resolve(Some("token"), 1_000, &verifier);
        assert!(!gate.is_open());
    }

    #[test]
    fn a_verifier_that_authorizes_a_live_token_opens_the_gate() {
        let verifier = StubVerifier {
            result: Ok(C1Authorization {
                token_id: "t1".into(),
                issued_at_ms: 0,
                expires_at_ms: 5_000,
            }),
        };
        let gate = C1Gate::resolve(Some("token"), 1_000, &verifier);
        assert!(gate.is_open());
    }
}
