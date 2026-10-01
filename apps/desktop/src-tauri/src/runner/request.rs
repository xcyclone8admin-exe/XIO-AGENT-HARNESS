//! Strict parsing of an invocation request (XIO-REQ-CMP-001, REQ-DATA-001).
//!
//! Every field is validated before anything downstream (gate check, process construction) sees
//! the request. Parsing never touches the filesystem or the network: workspace containment is a
//! lexical check on the paths as given, not a guarantee against a symlink planted after the check
//! — that deeper guarantee belongs to the OS-level isolation in `capability.rs` and whatever spawns
//! the process once C1 is authorized, not to this layer.

use std::path::{Component, Path, PathBuf};

pub const MAX_RUN_ID_LEN: usize = 128;
pub const MAX_ARGS: usize = 64;
pub const MAX_ARG_LEN: usize = 4096;
pub const MAX_PROGRAM_LEN: usize = 260;
pub const MIN_TIMEOUT_MS: u64 = 1_000;
pub const MAX_TIMEOUT_MS: u64 = 15 * 60 * 1000;
pub const MAX_OUTPUT_BYTES: u64 = 16 * 1024 * 1024;

/// Environment variable names an invocation may set. Anything else is refused regardless of
/// value, and anything on this list is still rejected if its value looks like a live secret.
pub const ALLOWED_ENV_NAMES: &[&str] = &["XYRA_RUN_ID", "XYRA_WORKSPACE_ID"];

/// A request exactly as received from a caller, before any validation. Every field is a plain
/// value so a malformed or hostile caller cannot smuggle anything through a richer type.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RawInvocationRequest {
    pub run_id: String,
    pub workspace_root: PathBuf,
    pub cwd: PathBuf,
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub timeout_ms: u64,
    pub max_output_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InvocationTarget {
    pub program: String,
    pub args: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InvocationRequest {
    pub run_id: String,
    pub workspace_root: PathBuf,
    pub cwd: PathBuf,
    pub target: InvocationTarget,
    pub env: Vec<(String, String)>,
    pub timeout_ms: u64,
    pub max_output_bytes: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RequestError {
    EmptyRunId,
    RunIdTooLong,
    RunIdHasControlCharacters,
    EmptyProgram,
    ProgramTooLong,
    ProgramNotAllowListed(String),
    TooManyArguments(usize),
    ArgumentTooLong { index: usize, len: usize },
    ArgumentContainsNul(usize),
    WorkspaceNotAbsolute,
    CwdNotAbsolute,
    CwdEscapesWorkspace,
    EnvVariableNotAllowListed(String),
    EnvValueLooksLikeSecret(String),
    TimeoutZero,
    TimeoutOutOfRange(u64),
    MaxOutputBytesZero,
    MaxOutputBytesOutOfRange(u64),
}

impl std::fmt::Display for RequestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyRunId => write!(f, "run id is empty"),
            Self::RunIdTooLong => write!(f, "run id exceeds {MAX_RUN_ID_LEN} characters"),
            Self::RunIdHasControlCharacters => write!(f, "run id contains control characters"),
            Self::EmptyProgram => write!(f, "program is empty"),
            Self::ProgramTooLong => write!(f, "program path exceeds {MAX_PROGRAM_LEN} characters"),
            Self::ProgramNotAllowListed(name) => {
                write!(f, "program {name} is not allow-listed for this workspace")
            }
            Self::TooManyArguments(n) => write!(f, "{n} arguments exceeds the limit of {MAX_ARGS}"),
            Self::ArgumentTooLong { index, len } => {
                write!(f, "argument {index} is {len} bytes, over the {MAX_ARG_LEN} limit")
            }
            Self::ArgumentContainsNul(index) => write!(f, "argument {index} contains a NUL byte"),
            Self::WorkspaceNotAbsolute => write!(f, "workspace root must be an absolute path"),
            Self::CwdNotAbsolute => write!(f, "working directory must be an absolute path"),
            Self::CwdEscapesWorkspace => {
                write!(f, "working directory is outside the request's workspace root")
            }
            Self::EnvVariableNotAllowListed(name) => {
                write!(f, "environment variable {name} is not allow-listed")
            }
            Self::EnvValueLooksLikeSecret(name) => {
                write!(f, "environment variable {name} carries a value that looks like a secret")
            }
            Self::TimeoutZero => write!(f, "timeout must be greater than zero"),
            Self::TimeoutOutOfRange(ms) => write!(
                f,
                "timeout {ms}ms is outside the allowed [{MIN_TIMEOUT_MS}, {MAX_TIMEOUT_MS}] range"
            ),
            Self::MaxOutputBytesZero => write!(f, "max output bytes must be greater than zero"),
            Self::MaxOutputBytesOutOfRange(n) => write!(
                f,
                "max output bytes {n} exceeds the {MAX_OUTPUT_BYTES} limit"
            ),
        }
    }
}

impl std::error::Error for RequestError {}

impl InvocationRequest {
    /// Validate a raw request against an explicit allow-list of programs. `allow_listed_programs`
    /// is compared case-insensitively (Windows path semantics); callers pass the exact set a
    /// workspace has been granted, never a wildcard.
    pub fn parse(
        raw: RawInvocationRequest,
        allow_listed_programs: &[String],
    ) -> Result<Self, RequestError> {
        if raw.run_id.is_empty() {
            return Err(RequestError::EmptyRunId);
        }
        if raw.run_id.chars().count() > MAX_RUN_ID_LEN {
            return Err(RequestError::RunIdTooLong);
        }
        if raw.run_id.chars().any(|c| c.is_control()) {
            return Err(RequestError::RunIdHasControlCharacters);
        }

        if raw.program.is_empty() {
            return Err(RequestError::EmptyProgram);
        }
        if raw.program.len() > MAX_PROGRAM_LEN {
            return Err(RequestError::ProgramTooLong);
        }
        if !allow_listed_programs
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(&raw.program))
        {
            return Err(RequestError::ProgramNotAllowListed(raw.program));
        }

        if raw.args.len() > MAX_ARGS {
            return Err(RequestError::TooManyArguments(raw.args.len()));
        }
        for (index, arg) in raw.args.iter().enumerate() {
            if arg.len() > MAX_ARG_LEN {
                return Err(RequestError::ArgumentTooLong {
                    index,
                    len: arg.len(),
                });
            }
            if arg.contains('\0') {
                return Err(RequestError::ArgumentContainsNul(index));
            }
        }

        if !raw.workspace_root.is_absolute() {
            return Err(RequestError::WorkspaceNotAbsolute);
        }
        if !raw.cwd.is_absolute() {
            return Err(RequestError::CwdNotAbsolute);
        }
        if !is_contained(&raw.workspace_root, &raw.cwd) {
            return Err(RequestError::CwdEscapesWorkspace);
        }

        for (name, value) in &raw.env {
            if !ALLOWED_ENV_NAMES.contains(&name.as_str()) {
                return Err(RequestError::EnvVariableNotAllowListed(name.clone()));
            }
            if looks_like_secret(name, value) {
                return Err(RequestError::EnvValueLooksLikeSecret(name.clone()));
            }
        }

        if raw.timeout_ms == 0 {
            return Err(RequestError::TimeoutZero);
        }
        if raw.timeout_ms < MIN_TIMEOUT_MS || raw.timeout_ms > MAX_TIMEOUT_MS {
            return Err(RequestError::TimeoutOutOfRange(raw.timeout_ms));
        }

        if raw.max_output_bytes == 0 {
            return Err(RequestError::MaxOutputBytesZero);
        }
        if raw.max_output_bytes > MAX_OUTPUT_BYTES {
            return Err(RequestError::MaxOutputBytesOutOfRange(raw.max_output_bytes));
        }

        Ok(InvocationRequest {
            run_id: raw.run_id,
            workspace_root: raw.workspace_root,
            cwd: raw.cwd,
            target: InvocationTarget {
                program: raw.program,
                args: raw.args,
            },
            env: raw.env,
            timeout_ms: raw.timeout_ms,
            max_output_bytes: raw.max_output_bytes,
        })
    }
}

/// Lexical containment check: `candidate` must be `root` or a descendant of it once `.` and `..`
/// components are resolved against the path text alone (no filesystem access, so this works for
/// paths that do not exist yet). Both paths must already be absolute.
pub fn is_contained(root: &Path, candidate: &Path) -> bool {
    if !root.is_absolute() || !candidate.is_absolute() {
        return false;
    }
    normalize(candidate).starts_with(normalize(root))
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// A coarse heuristic: an allow-listed name whose value still reads like a live credential is
/// refused rather than trusted. This is a second line of defence, not a secret scanner.
fn looks_like_secret(name: &str, value: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    let name_suggests_secret = ["KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL"]
        .iter()
        .any(|needle| upper.contains(needle));
    if name_suggests_secret {
        return true;
    }
    // A long, high-entropy-looking opaque value under an otherwise-innocuous name is still refused.
    value.len() >= 32 && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '+' || c == '/' || c == '=')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> RawInvocationRequest {
        RawInvocationRequest {
            run_id: "run-1".into(),
            workspace_root: PathBuf::from(r"C:\Users\test\workspace"),
            cwd: PathBuf::from(r"C:\Users\test\workspace\project"),
            program: "node.exe".into(),
            args: vec!["main.js".into()],
            env: vec![],
            timeout_ms: 5_000,
            max_output_bytes: 1024,
        }
    }

    fn allow_list() -> Vec<String> {
        vec!["node.exe".into()]
    }

    #[test]
    fn a_well_formed_request_parses() {
        let parsed = InvocationRequest::parse(base(), &allow_list()).unwrap();
        assert_eq!(parsed.target.program, "node.exe");
        assert_eq!(parsed.target.args, vec!["main.js".to_string()]);
    }

    #[test]
    fn a_program_outside_the_allow_list_is_refused() {
        let mut raw = base();
        raw.program = "cmd.exe".into();
        let err = InvocationRequest::parse(raw, &allow_list()).unwrap_err();
        assert_eq!(err, RequestError::ProgramNotAllowListed("cmd.exe".into()));
    }

    #[test]
    fn an_empty_run_id_is_refused() {
        let mut raw = base();
        raw.run_id = String::new();
        assert_eq!(
            InvocationRequest::parse(raw, &allow_list()).unwrap_err(),
            RequestError::EmptyRunId
        );
    }

    #[test]
    fn too_many_arguments_is_refused() {
        let mut raw = base();
        raw.args = (0..MAX_ARGS + 1).map(|n| n.to_string()).collect();
        assert_eq!(
            InvocationRequest::parse(raw, &allow_list()).unwrap_err(),
            RequestError::TooManyArguments(MAX_ARGS + 1)
        );
    }

    #[test]
    fn an_argument_with_a_nul_byte_is_refused() {
        let mut raw = base();
        raw.args = vec!["safe".into(), "bad\0arg".into()];
        assert_eq!(
            InvocationRequest::parse(raw, &allow_list()).unwrap_err(),
            RequestError::ArgumentContainsNul(1)
        );
    }

    #[test]
    fn a_cwd_that_escapes_the_workspace_via_dot_dot_is_refused() {
        let mut raw = base();
        raw.cwd = PathBuf::from(r"C:\Users\test\workspace\..\other");
        assert_eq!(
            InvocationRequest::parse(raw, &allow_list()).unwrap_err(),
            RequestError::CwdEscapesWorkspace
        );
    }

    #[test]
    fn a_cwd_that_only_shares_a_string_prefix_is_still_refused() {
        // "...\workspace-evil" textually starts with "...\workspace" but is a sibling directory.
        let mut raw = base();
        raw.cwd = PathBuf::from(r"C:\Users\test\workspace-evil");
        assert_eq!(
            InvocationRequest::parse(raw, &allow_list()).unwrap_err(),
            RequestError::CwdEscapesWorkspace
        );
    }

    #[test]
    fn a_relative_workspace_root_is_refused() {
        let mut raw = base();
        raw.workspace_root = PathBuf::from("workspace");
        raw.cwd = PathBuf::from(r"workspace\project");
        assert_eq!(
            InvocationRequest::parse(raw, &allow_list()).unwrap_err(),
            RequestError::WorkspaceNotAbsolute
        );
    }

    #[test]
    fn an_env_name_outside_the_allow_list_is_refused() {
        let mut raw = base();
        raw.env = vec![("PATH".into(), "whatever".into())];
        assert_eq!(
            InvocationRequest::parse(raw, &allow_list()).unwrap_err(),
            RequestError::EnvVariableNotAllowListed("PATH".into())
        );
    }

    #[test]
    fn an_allow_listed_name_with_a_secret_shaped_value_is_still_refused() {
        let mut raw = base();
        raw.env = vec![(
            "XYRA_RUN_ID".into(),
            "sk-live-aBcDeFgHiJkLmNoPqRsTuVwXyZ012345".into(),
        )];
        assert_eq!(
            InvocationRequest::parse(raw, &allow_list()).unwrap_err(),
            RequestError::EnvValueLooksLikeSecret("XYRA_RUN_ID".into())
        );
    }

    #[test]
    fn timeout_bounds_are_enforced() {
        let mut raw = base();
        raw.timeout_ms = 0;
        assert_eq!(
            InvocationRequest::parse(raw.clone(), &allow_list()).unwrap_err(),
            RequestError::TimeoutZero
        );
        raw.timeout_ms = MAX_TIMEOUT_MS + 1;
        assert_eq!(
            InvocationRequest::parse(raw, &allow_list()).unwrap_err(),
            RequestError::TimeoutOutOfRange(MAX_TIMEOUT_MS + 1)
        );
    }

    #[test]
    fn max_output_bytes_bounds_are_enforced() {
        let mut raw = base();
        raw.max_output_bytes = MAX_OUTPUT_BYTES + 1;
        assert_eq!(
            InvocationRequest::parse(raw, &allow_list()).unwrap_err(),
            RequestError::MaxOutputBytesOutOfRange(MAX_OUTPUT_BYTES + 1)
        );
    }

    #[test]
    fn containment_check_rejects_prefix_collisions_directly() {
        assert!(is_contained(
            Path::new(r"C:\ws"),
            Path::new(r"C:\ws\child")
        ));
        assert!(!is_contained(
            Path::new(r"C:\ws"),
            Path::new(r"C:\ws-evil")
        ));
        assert!(!is_contained(
            Path::new(r"C:\ws"),
            Path::new(r"C:\ws\..\outside")
        ));
    }
}
