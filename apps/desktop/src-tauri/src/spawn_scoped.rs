//! The one way the shell starts a child process (ADR-0008 Amendment 1 §A).
//!
//! Every child begins from an EMPTY environment. Only a short allow-list of OS variables is
//! copied from the shell, plus explicitly named shell-owned `XYRA_*` settings. Nothing else in the
//! parent environment (API keys, `NODE_OPTIONS`, a stale `XYRA_*`) can leak into a child, and no
//! keychain value is ever an environment variable.

use std::ffi::OsString;
use std::fmt;
use std::path::Path;
use std::process::Command;

/// OS variables a child may inherit: enough for Node, the C runtime and locale, nothing more.
pub const INHERITED_ENV: &[&str] = &[
    "PATH",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LC_MESSAGES",
    "TZ",
];

/// Settings the shell itself sets for the sidecar. These are non-secret configuration, except the
/// per-launch session token the sidecar's HTTP boundary requires today (see docs/packaging-spikes.md
/// for the proposal to move it to a stdin handoff).
pub const SHELL_OWNED_ENV: &[&str] = &[
    "XYRA_SIDECAR_PORT",
    "XYRA_DATA_DIR",
    "XYRA_OS_SUBJECT",
    "XYRA_DISPLAY_NAME",
    "XYRA_LAUNCH_TOKEN",
    "XYRA_ALLOWED_ORIGINS",
];

#[derive(Debug, PartialEq, Eq)]
pub enum ScopedSpawnError {
    /// A caller tried to pass an environment variable that is not allow-listed.
    UndeclaredVariable(String),
    /// A caller tried to pass a value that is a live secret held by the broker.
    SecretValue(String),
}

impl fmt::Display for ScopedSpawnError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UndeclaredVariable(name) => {
                write!(f, "environment variable {name} is not allow-listed")
            }
            Self::SecretValue(name) => {
                write!(f, "environment variable {name} carries a secret value")
            }
        }
    }
}

impl std::error::Error for ScopedSpawnError {}

/// Build a command with a scrubbed environment.
///
/// `explicit` names must be in `SHELL_OWNED_ENV`; `is_secret` lets the caller reject any value
/// that equals a secret it knows (the broker's live values), as a second line of defence.
pub fn scoped_command(
    program: &Path,
    args: &[OsString],
    explicit: &[(&str, String)],
    is_secret: &dyn Fn(&str) -> bool,
) -> Result<Command, ScopedSpawnError> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    cmd.env_clear();
    for name in INHERITED_ENV {
        if let Some(value) = std::env::var_os(name) {
            if is_secret(&value.to_string_lossy()) {
                return Err(ScopedSpawnError::SecretValue((*name).to_string()));
            }
            cmd.env(name, value);
        }
    }
    for (name, value) in explicit {
        if !SHELL_OWNED_ENV.contains(name) {
            return Err(ScopedSpawnError::UndeclaredVariable((*name).to_string()));
        }
        if is_secret(value) {
            return Err(ScopedSpawnError::SecretValue((*name).to_string()));
        }
        cmd.env(name, value);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(cmd)
}

/// Names of every variable a command will pass to its child (after `env_clear`).
pub fn declared_env(cmd: &Command) -> Vec<String> {
    cmd.get_envs()
        .filter(|(_, value)| value.is_some())
        .map(|(key, _)| key.to_string_lossy().to_ascii_uppercase())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;

    fn never(_: &str) -> bool {
        false
    }

    #[test]
    fn undeclared_variables_are_refused() {
        let err = scoped_command(
            Path::new("node"),
            &[],
            &[("ANTHROPIC_API_KEY", "x".into())],
            &never,
        )
        .unwrap_err();
        assert_eq!(
            err,
            ScopedSpawnError::UndeclaredVariable("ANTHROPIC_API_KEY".into())
        );
        let err = scoped_command(
            Path::new("node"),
            &[],
            &[("NODE_OPTIONS", "--require x".into())],
            &never,
        )
        .unwrap_err();
        assert!(matches!(err, ScopedSpawnError::UndeclaredVariable(_)));
    }

    #[test]
    fn a_known_secret_value_is_refused_even_under_an_allowed_name() {
        let secret = "value-held-by-the-broker-0f3a";
        let is_secret = |v: &str| v == secret;
        let err = scoped_command(
            Path::new("node"),
            &[],
            &[("XYRA_DISPLAY_NAME", secret.to_string())],
            &is_secret,
        )
        .unwrap_err();
        assert_eq!(
            err,
            ScopedSpawnError::SecretValue("XYRA_DISPLAY_NAME".into())
        );
    }

    #[test]
    fn only_allow_listed_names_are_declared() {
        let cmd = scoped_command(
            Path::new("node"),
            &[],
            &[("XYRA_SIDECAR_PORT", "4000".into())],
            &never,
        )
        .unwrap();
        for name in declared_env(&cmd) {
            assert!(
                INHERITED_ENV.contains(&name.as_str()) || SHELL_OWNED_ENV.contains(&name.as_str()),
                "{name} leaked into the child environment"
            );
        }
    }

    /// Spawns a real child and reads its environment back: the parent's secret-looking variables
    /// must not arrive, and every name that does arrive must be allow-listed.
    #[cfg(windows)]
    #[test]
    fn a_real_child_sees_only_the_allow_list() {
        let planted = "planted-parent-secret-7c1e9b";
        // Only this test sets these names; other tests spawn cmd.exe, which ignores NODE_OPTIONS.
        std::env::set_var("XYRA_TEST_PROVIDER_API_KEY", planted);
        std::env::set_var("NODE_OPTIONS", "--require planted-module");
        let systemroot = std::env::var("SYSTEMROOT").unwrap_or_else(|_| r"C:\Windows".into());
        let cmd_exe = Path::new(&systemroot).join("System32").join("cmd.exe");
        let mut cmd = scoped_command(
            &cmd_exe,
            &["/d".into(), "/c".into(), "set".into()],
            &[("XYRA_DISPLAY_NAME", "Test user".into())],
            &never,
        )
        .unwrap();
        let out = cmd.stdout(Stdio::piped()).output().expect("cmd.exe runs");
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(!text.contains(planted), "a parent secret reached the child");
        assert!(!text.to_ascii_uppercase().contains("NODE_OPTIONS"));
        for line in text.lines() {
            let Some((name, _)) = line.split_once('=') else {
                continue;
            };
            let name = name.to_ascii_uppercase();
            // cmd.exe itself synthesises PROMPT/COMSPEC/PATHEXT-style defaults; those carry no data.
            let synthesised = ["PROMPT", "COMSPEC", "PATHEXT"].contains(&name.as_str());
            assert!(
                synthesised
                    || INHERITED_ENV.contains(&name.as_str())
                    || SHELL_OWNED_ENV.contains(&name.as_str()),
                "unexpected child variable {name}"
            );
        }
        std::env::remove_var("XYRA_TEST_PROVIDER_API_KEY");
        std::env::remove_var("NODE_OPTIONS");
    }
}
