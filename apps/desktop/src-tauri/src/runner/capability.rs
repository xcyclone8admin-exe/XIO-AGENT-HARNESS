//! Windows isolation capability detection (REQ-AIS-002).
//!
//! The broker must know, before it would ever authorize a spawn, whether the OS primitives an
//! isolated run depends on are actually available on this machine. A probe that silently assumes
//! "yes" when it can't tell is worse than no probe at all, because it lets a weaker-than-intended
//! run look identical to a fully isolated one. Every function here reports `available: false` with
//! a reason on any doubt; it never upgrades a failed or skipped probe to "available".
//!
//! Probing a job object means creating and immediately closing one kernel handle — no process is
//! created and nothing is spawned.

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum IsolationCapability {
    /// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, as used by `job.rs` for the sidecar.
    JobObjectKillOnClose,
    /// A restricted/least-privilege primary token for the child process.
    RestrictedToken,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IsolationReport {
    pub capability: IsolationCapability,
    pub available: bool,
    pub detail: Option<String>,
}

impl IsolationReport {
    fn unavailable(capability: IsolationCapability, detail: impl Into<String>) -> Self {
        Self {
            capability,
            available: false,
            detail: Some(detail.into()),
        }
    }

    fn available(capability: IsolationCapability) -> Self {
        Self {
            capability,
            available: true,
            detail: None,
        }
    }
}

/// Probe every isolation capability the runner can make use of. Order is stable: job object then
/// restricted token.
pub fn detect_all() -> Vec<IsolationReport> {
    vec![detect_job_object(), detect_restricted_token()]
}

/// All requested capabilities are reported `available`. An empty requirement list is trivially
/// satisfied — callers that require isolation must say so explicitly.
pub fn all_available(reports: &[IsolationReport], required: &[IsolationCapability]) -> bool {
    required
        .iter()
        .all(|needed| reports.iter().any(|r| r.capability == *needed && r.available))
}

#[cfg(windows)]
fn detect_job_object() -> IsolationReport {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::CreateJobObjectW;
    // SAFETY: both calls take no borrowed/foreign pointers beyond the null defaults Win32 accepts,
    // and the handle is closed before this function returns regardless of outcome.
    unsafe {
        let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if handle.is_null() {
            let err = std::io::Error::last_os_error();
            return IsolationReport::unavailable(
                IsolationCapability::JobObjectKillOnClose,
                format!("CreateJobObjectW failed: {err}"),
            );
        }
        CloseHandle(handle);
    }
    IsolationReport::available(IsolationCapability::JobObjectKillOnClose)
}

#[cfg(not(windows))]
fn detect_job_object() -> IsolationReport {
    IsolationReport::unavailable(
        IsolationCapability::JobObjectKillOnClose,
        "job objects are a Windows-only primitive",
    )
}

#[cfg(windows)]
fn detect_restricted_token() -> IsolationReport {
    // `CreateRestrictedToken`-based isolation for a child process is not implemented in this
    // crate yet (tracked separately from this task's scope). Reporting "available" without a real
    // creation path would be exactly the silent weakening REQ-AIS-002 forbids, so this stays
    // unavailable unconditionally until that implementation lands, rather than probing for a
    // partial signal (e.g. token queryability) that doesn't actually prove the capability works.
    IsolationReport::unavailable(
        IsolationCapability::RestrictedToken,
        "restricted-token creation for a child process is not implemented yet",
    )
}

#[cfg(not(windows))]
fn detect_restricted_token() -> IsolationReport {
    IsolationReport::unavailable(
        IsolationCapability::RestrictedToken,
        "restricted tokens are a Windows-only primitive",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_all_reports_every_known_capability_exactly_once() {
        let reports = detect_all();
        assert_eq!(reports.len(), 2);
        assert!(reports
            .iter()
            .any(|r| r.capability == IsolationCapability::JobObjectKillOnClose));
        assert!(reports
            .iter()
            .any(|r| r.capability == IsolationCapability::RestrictedToken));
    }

    #[test]
    fn an_unavailable_capability_always_carries_a_reason() {
        for report in detect_all() {
            if !report.available {
                assert!(
                    report.detail.is_some(),
                    "{:?} reported unavailable without a reason",
                    report.capability
                );
            }
        }
    }

    #[test]
    fn restricted_token_creation_is_reported_unavailable_rather_than_assumed() {
        let report = detect_restricted_token();
        assert!(
            !report.available,
            "restricted-token child creation is not implemented; it must never report available"
        );
    }

    #[test]
    fn all_available_is_vacuously_true_for_no_requirements() {
        assert!(all_available(&[], &[]));
    }

    #[test]
    fn all_available_is_false_when_a_required_capability_is_missing_from_the_reports() {
        let reports = vec![IsolationReport::available(IsolationCapability::JobObjectKillOnClose)];
        assert!(!all_available(
            &reports,
            &[IsolationCapability::RestrictedToken]
        ));
    }

    #[test]
    fn all_available_is_false_when_a_required_capability_was_reported_unavailable() {
        let reports = vec![IsolationReport::unavailable(
            IsolationCapability::JobObjectKillOnClose,
            "probe failed",
        )];
        assert!(!all_available(
            &reports,
            &[IsolationCapability::JobObjectKillOnClose]
        ));
    }

    #[cfg(windows)]
    #[test]
    fn job_object_probing_does_not_leak_a_handle_across_many_calls() {
        // A handle leak would eventually fail CreateJobObjectW; a few thousand immediate
        // create+close cycles is enough to catch a missing CloseHandle without being slow.
        for _ in 0..2_000 {
            let report = detect_job_object();
            assert!(report.available, "{:?}", report.detail);
        }
    }
}
