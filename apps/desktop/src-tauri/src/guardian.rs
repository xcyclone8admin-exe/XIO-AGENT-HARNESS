//! Crash-loop policy for the sidecar supervisor.
//!
//! Ported from starnet `src-tauri/src/main.rs` (`spawn_guardian`, `guardian_backoff`,
//! `GuardianStatus`), MIT. Two changes: the crash count resets only after the sidecar has stayed
//! up for `stable_uptime` (starnet reset it on any live poll, so a sidecar crashing a few seconds
//! after boot never reached the cap), and a "graceful" exit that happens almost immediately still
//! counts as a crash, so an exit-0 loop cannot spin forever.

use std::time::{Duration, Instant};

use serde::Serialize;

use crate::logging::now_ms;

#[derive(Clone, Copy, Debug)]
pub struct GuardianPolicy {
    /// Unexpected exits inside `window` before the guardian stops respawning.
    pub max_crashes: u32,
    pub window: Duration,
    pub backoff_base: Duration,
    pub backoff_cap: Duration,
    /// Uptime after which a running sidecar is considered healthy and the crash count resets.
    pub stable_uptime: Duration,
    /// A graceful exit sooner than this after start is treated as a crash.
    pub min_graceful_uptime: Duration,
    /// A child that is alive but never reports ready within this is stopped (counts as a crash).
    pub ready_timeout: Duration,
    pub poll: Duration,
}

impl Default for GuardianPolicy {
    fn default() -> Self {
        Self {
            max_crashes: 6,
            window: Duration::from_secs(10 * 60),
            backoff_base: Duration::from_secs(1),
            backoff_cap: Duration::from_secs(30),
            stable_uptime: Duration::from_secs(60),
            min_graceful_uptime: Duration::from_secs(5),
            ready_timeout: Duration::from_secs(60),
            poll: Duration::from_millis(500),
        }
    }
}

impl GuardianPolicy {
    /// 1×, 2×, 4×, … the base delay before the n-th consecutive crash respawn, capped.
    pub fn backoff(&self, consecutive_crashes: u32) -> Duration {
        let exponent = consecutive_crashes.max(1).saturating_sub(1).min(16);
        self.backoff_base
            .checked_mul(1u32 << exponent)
            .unwrap_or(self.backoff_cap)
            .min(self.backoff_cap)
    }
}

/// Exit codes the sidecar uses when it chose to stop: 0 graceful, 75 restart request.
pub fn exit_is_graceful(code: Option<i32>) -> bool {
    matches!(code, Some(0) | Some(75))
}

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Respawn { after: Duration },
    Halt,
}

/// What the UI and tray may show. Serialized camelCase for the WebView.
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GuardianStatus {
    pub state: ServiceState,
    pub halted: bool,
    pub consecutive_crashes: u32,
    pub last_exit_code: Option<i32>,
    pub last_exit_at_ms: Option<u64>,
    pub next_respawn_in_ms: Option<u64>,
    pub reason: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ServiceState {
    #[default]
    Starting,
    Ready,
    Restarting,
    Halted,
    Stopped,
}

pub struct Guardian {
    policy: GuardianPolicy,
    crashes: u32,
    window_start: Option<Instant>,
    halted: bool,
    last_exit_code: Option<i32>,
    last_exit_at_ms: Option<u64>,
    reason: Option<String>,
}

impl Guardian {
    pub fn new(policy: GuardianPolicy) -> Self {
        Self {
            policy,
            crashes: 0,
            window_start: None,
            halted: false,
            last_exit_code: None,
            last_exit_at_ms: None,
            reason: None,
        }
    }

    pub fn policy(&self) -> &GuardianPolicy {
        &self.policy
    }

    pub fn halted(&self) -> bool {
        self.halted
    }

    pub fn crashes(&self) -> u32 {
        self.crashes
    }

    /// Classify one child exit and decide what happens next.
    pub fn on_exit(&mut self, code: Option<i32>, uptime: Duration, now: Instant) -> Verdict {
        self.last_exit_code = code;
        self.last_exit_at_ms = Some(now_ms());
        if exit_is_graceful(code) && uptime >= self.policy.min_graceful_uptime {
            self.crashes = 0;
            self.window_start = None;
            self.reason = None;
            return Verdict::Respawn {
                after: self.policy.backoff_base,
            };
        }
        let window_expired = self
            .window_start
            .is_none_or(|start| now.duration_since(start) > self.policy.window);
        if window_expired {
            self.window_start = Some(now);
            self.crashes = 0;
        }
        self.crashes = self.crashes.saturating_add(1);
        if self.crashes >= self.policy.max_crashes {
            self.halted = true;
            self.reason = Some(format!(
                "The local service stopped {} times in {} minutes (last exit code {}). Automatic restarts are paused; use Restart local service to try again.",
                self.crashes,
                self.policy.window.as_secs().div_ceil(60).max(1),
                code.map_or_else(|| "none".to_string(), |c| c.to_string()),
            ));
            return Verdict::Halt;
        }
        let after = self.policy.backoff(self.crashes);
        self.reason = Some(format!(
            "The local service stopped unexpectedly (restart {} of {}).",
            self.crashes, self.policy.max_crashes
        ));
        Verdict::Respawn { after }
    }

    /// The child has run for `stable_uptime`: forget earlier crashes.
    pub fn on_stable(&mut self) {
        if self.crashes != 0 || self.reason.is_some() {
            self.crashes = 0;
            self.window_start = None;
            self.reason = None;
        }
    }

    /// A user-requested restart clears a halt and the crash history.
    pub fn reset(&mut self) {
        self.crashes = 0;
        self.window_start = None;
        self.halted = false;
        self.reason = None;
    }

    pub fn status(&self, state: ServiceState, next_respawn_in: Option<Duration>) -> GuardianStatus {
        GuardianStatus {
            state: if self.halted {
                ServiceState::Halted
            } else {
                state
            },
            halted: self.halted,
            consecutive_crashes: self.crashes,
            last_exit_code: self.last_exit_code,
            last_exit_at_ms: self.last_exit_at_ms,
            next_respawn_in_ms: next_respawn_in.map(|d| d.as_millis() as u64),
            reason: self.reason.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LONG: Duration = Duration::from_secs(3600);

    #[test]
    fn backoff_doubles_from_the_base_and_caps() {
        let p = GuardianPolicy::default();
        let secs: Vec<u64> = (0..=8).map(|n| p.backoff(n).as_secs()).collect();
        assert_eq!(secs, vec![1, 1, 2, 4, 8, 16, 30, 30, 30]);
        assert_eq!(p.backoff(u32::MAX), p.backoff_cap);
    }

    #[test]
    fn halts_on_the_sixth_crash_inside_the_window() {
        let mut g = Guardian::new(GuardianPolicy::default());
        let t0 = Instant::now();
        for n in 1..6 {
            let v = g.on_exit(Some(1), Duration::from_secs(2), t0 + Duration::from_secs(n));
            assert!(
                matches!(v, Verdict::Respawn { .. }),
                "crash {n} should respawn"
            );
        }
        assert_eq!(
            g.on_exit(Some(1), Duration::from_secs(2), t0 + Duration::from_secs(6)),
            Verdict::Halt
        );
        assert!(g.halted());
        let status = g.status(ServiceState::Restarting, None);
        assert_eq!(status.state, ServiceState::Halted);
        assert!(status.reason.unwrap().contains("paused"));
    }

    #[test]
    fn crashes_outside_the_window_start_a_new_count() {
        let p = GuardianPolicy::default();
        let mut g = Guardian::new(p);
        let t0 = Instant::now();
        for n in 0..5 {
            g.on_exit(Some(1), Duration::ZERO, t0 + Duration::from_secs(n));
        }
        assert_eq!(g.crashes(), 5);
        g.on_exit(
            Some(1),
            Duration::ZERO,
            t0 + p.window + Duration::from_secs(10),
        );
        assert_eq!(g.crashes(), 1);
        assert!(!g.halted());
    }

    #[test]
    fn graceful_exits_do_not_count_but_instant_ones_do() {
        let mut g = Guardian::new(GuardianPolicy::default());
        let now = Instant::now();
        assert_eq!(
            g.on_exit(Some(0), LONG, now),
            Verdict::Respawn {
                after: Duration::from_secs(1)
            }
        );
        assert_eq!(
            g.on_exit(Some(75), LONG, now),
            Verdict::Respawn {
                after: Duration::from_secs(1)
            }
        );
        assert_eq!(g.crashes(), 0);
        g.on_exit(Some(0), Duration::from_millis(100), now);
        assert_eq!(
            g.crashes(),
            1,
            "an exit-0 right after start is a crash loop, not a shutdown"
        );
    }

    #[test]
    fn stable_uptime_and_user_reset_clear_history() {
        let mut g = Guardian::new(GuardianPolicy::default());
        let now = Instant::now();
        g.on_exit(None, Duration::ZERO, now);
        g.on_exit(Some(1), Duration::ZERO, now);
        g.on_stable();
        assert_eq!(g.crashes(), 0);
        for _ in 0..6 {
            g.on_exit(Some(1), Duration::ZERO, now);
        }
        assert!(g.halted());
        g.reset();
        assert!(!g.halted());
        assert_eq!(g.crashes(), 0);
    }

    #[test]
    fn status_serializes_camel_case() {
        let g = Guardian::new(GuardianPolicy::default());
        let json =
            serde_json::to_string(&g.status(ServiceState::Ready, Some(Duration::from_secs(2))))
                .unwrap();
        assert!(json.contains("\"state\":\"ready\""));
        assert!(json.contains("\"consecutiveCrashes\":0"));
        assert!(json.contains("\"nextRespawnInMs\":2000"));
    }
}
