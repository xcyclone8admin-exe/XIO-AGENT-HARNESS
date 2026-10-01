//! Sidecar supervisor: launches the bundled Node sidecar on a private loopback port, watches for
//! its ready line, and respawns it under the crash-loop policy in `guardian.rs`.
//!
//! Structure ported from starnet `src-tauri/src/main.rs` (`spawn_sidecar`, `spawn_guardian`,
//! `free_port`, `strip_verbatim`) and `sidecar_startup.rs`, MIT, rebuilt around one lock-protected
//! state struct, a kill-on-close Job Object and the scrubbed-environment spawn helper.

use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use base64::Engine as _;

use crate::guardian::{Guardian, GuardianPolicy, GuardianStatus, ServiceState, Verdict};
use crate::job::KillOnCloseJob;
use crate::logging::Log;
use crate::spawn_scoped::scoped_command;

/// Printed by `apps/sidecar/src/main.ts` once its HTTP server is listening.
pub const READY_MARKER: &str = "sidecar ready on 127.0.0.1:";

/// What the shell launches: program, arguments and the shell-owned `XYRA_*` settings.
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub env: Vec<(&'static str, String)>,
    /// Both launch secrets are delivered once over child stdin and never placed in the environment.
    pub launch_token: String,
    pub native_sync_token: String,
    pub cwd: Option<PathBuf>,
}

/// Loopback port and per-launch token; the token goes to the WebView over IPC only.
#[derive(Clone)]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
    pub(crate) native_sync_token: String,
}

impl std::fmt::Debug for Endpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Endpoint")
            .field("port", &self.port)
            .field("token", &"<redacted>")
            .field("native_sync_token", &"<redacted>")
            .finish()
    }
}

/// Reserve an unused IPv4 loopback port, then release it for the sidecar to bind.
pub fn free_port() -> std::io::Result<u16> {
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

/// 256 bits from the OS CSPRNG, base64url without padding (43 characters).
pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("OS random source unavailable");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Node cannot use a `\\?\` verbatim path as its main module or cwd.
pub fn strip_verbatim(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => p.to_path_buf(),
    }
}

/// The bundled runtime (Tauri places `externalBin` next to the main executable); debug builds
/// without a staged runtime fall back to `node` on PATH.
pub fn node_binary(resource_dir: &Path) -> PathBuf {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    let mut candidates = vec![resource_dir.join(name)];
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(Path::to_path_buf))
    {
        candidates.push(dir.join(name));
    }
    candidates
        .into_iter()
        .map(|p| strip_verbatim(&p))
        .find(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from(name))
}

struct Inner {
    child: Option<Child>,
    generation: u64,
    ready_generation: u64,
    started_at: Option<Instant>,
    next_attempt: Option<Instant>,
    guardian: Guardian,
    stopped: bool,
}

type ReadyHook = Box<dyn Fn(u64) + Send + Sync>;

pub struct Supervisor {
    launch: Launch,
    endpoint: Endpoint,
    log: Log,
    inner: Mutex<Inner>,
    changed: Condvar,
    job: Option<KillOnCloseJob>,
    on_ready: Mutex<Option<ReadyHook>>,
    is_secret: Box<dyn Fn(&str) -> bool + Send + Sync>,
}

impl Supervisor {
    pub fn new(
        launch: Launch,
        endpoint: Endpoint,
        policy: GuardianPolicy,
        log: Log,
        is_secret: Box<dyn Fn(&str) -> bool + Send + Sync>,
    ) -> Arc<Self> {
        let job = match KillOnCloseJob::new() {
            Ok(job) => Some(job),
            Err(error) => {
                log.line(format!(
                    "job-object unavailable ({error}); orphan protection off"
                ));
                None
            }
        };
        Arc::new(Self {
            launch,
            endpoint,
            log,
            inner: Mutex::new(Inner {
                child: None,
                generation: 0,
                ready_generation: 0,
                started_at: None,
                next_attempt: None,
                guardian: Guardian::new(policy),
                stopped: false,
            }),
            changed: Condvar::new(),
            job,
            on_ready: Mutex::new(None),
            is_secret,
        })
    }

    /// Runs after each generation reports ready (argument: generation, starting at 1).
    pub fn set_on_ready(&self, hook: ReadyHook) {
        if let Ok(mut slot) = self.on_ready.lock() {
            *slot = Some(hook);
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Spawn the first child and start the guardian thread.
    pub fn start(self: &Arc<Self>) {
        {
            let mut inner = self.lock();
            self.spawn_or_schedule(&mut inner);
        }
        let me = Arc::clone(self);
        std::thread::Builder::new()
            .name("sidecar-guardian".into())
            .spawn(move || me.guard())
            .expect("guardian thread");
    }

    fn spawn_or_schedule(self: &Arc<Self>, inner: &mut Inner) {
        if let Err(error) = self.spawn_locked(inner) {
            self.log.line(format!("spawn failed: {error}"));
            let now = Instant::now();
            match inner.guardian.on_exit(None, Duration::ZERO, now) {
                Verdict::Respawn { after } => inner.next_attempt = Some(now + after),
                Verdict::Halt => inner.next_attempt = None,
            }
            self.changed.notify_all();
        }
    }

    fn spawn_locked(self: &Arc<Self>, inner: &mut Inner) -> std::io::Result<()> {
        let mut cmd = scoped_command(
            &self.launch.program,
            &self.launch.args,
            &self.launch.env,
            &*self.is_secret,
        )
        .map_err(std::io::Error::other)?;
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = &self.launch.cwd {
            cmd.current_dir(cwd);
        }
        let mut child = cmd.spawn()?;
        if let Some(mut stdin) = child.stdin.take() {
            let bootstrap = serde_json::json!({
                "protocolVersion": "xyra-native-bootstrap-v1",
                "launchToken": &self.launch.launch_token,
                "nativeSyncToken": &self.launch.native_sync_token,
            });
            serde_json::to_writer(&mut stdin, &bootstrap).map_err(std::io::Error::other)?;
            stdin.write_all(b"\n")?;
            // Drop immediately: the receiver requires EOF after this sole newline-terminated line.
        }
        if let Some(job) = &self.job {
            if let Err(error) = job.assign(&child) {
                self.log.line(format!("job-object assign failed: {error}"));
            }
        }
        inner.generation += 1;
        let generation = inner.generation;
        self.log
            .line(format!("spawned sidecar#{generation} pid={}", child.id()));
        if let Some(out) = child.stdout.take() {
            self.pump(generation, out, "out");
        }
        if let Some(err) = child.stderr.take() {
            self.pump(generation, err, "err");
        }
        inner.child = Some(child);
        inner.started_at = Some(Instant::now());
        inner.next_attempt = None;
        self.changed.notify_all();
        Ok(())
    }

    /// Copy child output to the sidecar log and watch stdout for the ready line.
    fn pump(
        self: &Arc<Self>,
        generation: u64,
        stream: impl Read + Send + 'static,
        label: &'static str,
    ) {
        let me = Arc::clone(self);
        let _ = std::thread::Builder::new()
            .name(format!("sidecar-{label}"))
            .spawn(move || {
                let mut reader = BufReader::new(stream);
                let mut buf = Vec::new();
                loop {
                    buf.clear();
                    match reader.read_until(b'\n', &mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            let line = String::from_utf8_lossy(&buf);
                            let line = line.trim_end();
                            me.log
                                .line(format!("[sidecar#{generation} {label}] {line}"));
                            if label == "out" && line.starts_with(READY_MARKER) {
                                me.mark_ready(generation);
                            }
                        }
                    }
                }
            });
    }

    fn mark_ready(&self, generation: u64) {
        {
            let mut inner = self.lock();
            if inner.generation != generation || inner.stopped {
                return;
            }
            inner.ready_generation = generation;
            self.changed.notify_all();
        }
        self.log.line(format!("sidecar#{generation} ready"));
        if let Ok(hook) = self.on_ready.lock() {
            if let Some(hook) = hook.as_ref() {
                hook(generation);
            }
        }
    }

    fn guard(self: Arc<Self>) {
        loop {
            let poll = self.lock().guardian.policy().poll;
            std::thread::sleep(poll);
            let mut inner = self.lock();
            if inner.stopped {
                break;
            }
            let now = Instant::now();
            let policy = *inner.guardian.policy();
            let uptime = inner
                .started_at
                .map(|t| now.duration_since(t))
                .unwrap_or_default();
            let ready = inner.ready_generation == inner.generation;
            let exited = match inner.child.as_mut().map(Child::try_wait) {
                Some(Ok(Some(status))) => Some(status.code()),
                Some(Ok(None)) => {
                    if !ready && uptime > policy.ready_timeout {
                        self.log.line(format!(
                            "sidecar#{} not ready after {}s; stopping it",
                            inner.generation,
                            policy.ready_timeout.as_secs()
                        ));
                        if let Some(child) = inner.child.as_mut() {
                            let _ = child.kill();
                        }
                    } else if ready && uptime > policy.stable_uptime {
                        inner.guardian.on_stable();
                    }
                    None
                }
                Some(Err(error)) => {
                    self.log.line(format!("try_wait failed: {error}"));
                    None
                }
                None => None,
            };
            if let Some(code) = exited {
                inner.child = None;
                let generation = inner.generation;
                match inner.guardian.on_exit(code, uptime, now) {
                    Verdict::Respawn { after } => {
                        self.log.line(format!(
                            "sidecar#{generation} exited code={code:?} uptime={}ms; respawn in {}ms",
                            uptime.as_millis(),
                            after.as_millis()
                        ));
                        inner.next_attempt = Some(now + after);
                    }
                    Verdict::Halt => {
                        self.log.line(format!(
                            "sidecar#{generation} exited code={code:?}; guardian HALTED"
                        ));
                        inner.next_attempt = None;
                    }
                }
                self.changed.notify_all();
                continue;
            }
            if inner.child.is_none()
                && !inner.guardian.halted()
                && inner.next_attempt.is_some_and(|t| now >= t)
            {
                self.spawn_or_schedule(&mut inner);
            }
        }
    }

    /// Block until the current generation is ready, the guardian halts, or `timeout` passes.
    pub fn wait_ready(&self, timeout: Duration) -> Result<Endpoint, GuardianStatus> {
        let deadline = Instant::now() + timeout;
        let mut inner = self.lock();
        loop {
            if !inner.stopped && inner.child.is_some() && inner.ready_generation == inner.generation
            {
                return Ok(self.endpoint.clone());
            }
            let now = Instant::now();
            if inner.stopped || inner.guardian.halted() || now >= deadline {
                drop(inner);
                return Err(self.status());
            }
            inner = self
                .changed
                .wait_timeout(inner, deadline - now)
                .map(|(guard, _)| guard)
                .unwrap_or_else(|poisoned| poisoned.into_inner().0);
        }
    }

    pub fn status(&self) -> GuardianStatus {
        let inner = self.lock();
        let now = Instant::now();
        let state = if inner.stopped {
            ServiceState::Stopped
        } else if inner.child.is_some() && inner.ready_generation == inner.generation {
            ServiceState::Ready
        } else if inner.generation <= 1 && inner.child.is_some() {
            ServiceState::Starting
        } else {
            ServiceState::Restarting
        };
        let next = inner.next_attempt.map(|t| t.saturating_duration_since(now));
        inner.guardian.status(state, next)
    }

    pub fn generation(&self) -> u64 {
        self.lock().generation
    }

    /// User-requested restart: clears a halt and starts a fresh child now.
    pub fn restart(self: &Arc<Self>) -> GuardianStatus {
        {
            let mut inner = self.lock();
            if inner.stopped {
                drop(inner);
                return self.status();
            }
            inner.guardian.reset();
            if let Some(mut child) = inner.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            self.log.line("restart requested by user");
            self.spawn_or_schedule(&mut inner);
        }
        self.status()
    }

    /// Intentional stop: the guardian will not respawn; every process in the job ends.
    pub fn shutdown(&self) {
        let mut inner = self.lock();
        if inner.stopped {
            return;
        }
        inner.stopped = true;
        if let Some(mut child) = inner.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(job) = &self.job {
            job.terminate_all();
        }
        self.changed.notify_all();
        self.log.line("sidecar stopped (shutdown)");
    }

    pub fn port(&self) -> u16 {
        self.endpoint.port
    }

    pub fn native_sync_token(&self) -> &str {
        &self.endpoint.native_sync_token
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::cloud_service::SidecarTransport;

    fn cmd_exe() -> PathBuf {
        let root = std::env::var("SYSTEMROOT").unwrap_or_else(|_| r"C:\Windows".into());
        Path::new(&root).join("System32").join("cmd.exe")
    }

    fn fast_policy() -> GuardianPolicy {
        GuardianPolicy {
            max_crashes: 4,
            window: Duration::from_secs(60),
            backoff_base: Duration::from_millis(40),
            backoff_cap: Duration::from_millis(160),
            stable_uptime: Duration::from_secs(60),
            min_graceful_uptime: Duration::from_secs(5),
            ready_timeout: Duration::from_secs(10),
            poll: Duration::from_millis(20),
        }
    }

    fn supervisor(script: &str, cwd: Option<PathBuf>) -> Arc<Supervisor> {
        Supervisor::new(
            Launch {
                program: cmd_exe(),
                args: vec!["/d".into(), "/c".into(), script.into()],
                env: vec![],
                launch_token: random_token(),
                native_sync_token: random_token(),
                cwd,
            },
            Endpoint {
                port: 1,
                token: random_token(),
                native_sync_token: random_token(),
            },
            fast_policy(),
            Log::discard(),
            Box::new(|_| false),
        )
    }

    fn wait_until(limit: Duration, mut done: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            if done() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    }

    #[test]
    fn token_is_256_bits_and_unique() {
        let a = random_token();
        assert_eq!(a.len(), 43);
        assert_ne!(a, random_token());
    }

    #[test]
    fn crash_loop_backs_off_then_halts_and_a_user_restart_recovers() {
        let sup = supervisor("echo sidecar ready on 127.0.0.1:1& exit /b 3", None);
        let started = Instant::now();
        sup.start();
        assert!(
            wait_until(Duration::from_secs(10), || sup.status().halted),
            "guardian never halted"
        );
        let elapsed = started.elapsed();
        // Backoffs 40 + 80 + 160 ms separate the four spawns.
        assert!(
            elapsed >= Duration::from_millis(280),
            "respawned without backing off: {elapsed:?}"
        );
        assert_eq!(sup.generation(), 4);
        let status = sup.status();
        assert_eq!(status.consecutive_crashes, 4);
        assert_eq!(status.last_exit_code, Some(3));
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(sup.generation(), 4, "a halted guardian must not respawn");
        assert!(sup.wait_ready(Duration::from_millis(50)).is_err());

        let after = sup.restart();
        assert!(!after.halted);
        assert!(sup.generation() >= 5, "user restart spawns a fresh child");
        sup.shutdown();
    }

    #[test]
    fn a_crashed_sidecar_is_respawned_and_becomes_ready() {
        let dir = std::env::temp_dir().join(format!("xyra-guardian-{}", random_token()));
        std::fs::create_dir_all(&dir).unwrap();
        // First run: create the marker and crash. Later runs: report ready and stay up.
        let script = "if exist crashed.marker (echo sidecar ready on 127.0.0.1:1& ping -n 30 127.0.0.1 >nul) else (type nul > crashed.marker& exit /b 9)";
        let sup = supervisor(script, Some(dir.clone()));
        let reported = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&reported);
        sup.set_on_ready(Box::new(move |generation| {
            sink.lock().unwrap().push(generation)
        }));
        sup.start();
        let endpoint = sup
            .wait_ready(Duration::from_secs(10))
            .expect("respawned sidecar becomes ready");
        assert_eq!(endpoint.port, 1);
        assert_eq!(sup.generation(), 2);
        let status = sup.status();
        assert_eq!(status.state, ServiceState::Ready);
        assert_eq!(status.last_exit_code, Some(9));
        assert_eq!(*reported.lock().unwrap(), vec![2]);
        sup.shutdown();
        assert_eq!(sup.status().state, ServiceState::Stopped);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_child_that_never_reports_ready_is_stopped_and_counted() {
        let mut policy = fast_policy();
        policy.ready_timeout = Duration::from_millis(200);
        let sup = Supervisor::new(
            Launch {
                program: cmd_exe(),
                args: vec!["/d".into(), "/c".into(), "ping -n 30 127.0.0.1 >nul".into()],
                env: vec![],
                launch_token: random_token(),
                native_sync_token: random_token(),
                cwd: None,
            },
            Endpoint {
                port: 1,
                token: random_token(),
                native_sync_token: random_token(),
            },
            policy,
            Log::discard(),
            Box::new(|_| false),
        );
        sup.start();
        assert!(
            wait_until(Duration::from_secs(10), || sup.generation() >= 2),
            "silent child was not replaced"
        );
        assert!(sup.status().consecutive_crashes >= 1);
        sup.shutdown();
    }

    #[test]
    fn debug_output_never_shows_the_token() {
        let endpoint = Endpoint {
            port: 9,
            token: random_token(),
            native_sync_token: random_token(),
        };
        assert!(!format!("{endpoint:?}").contains(&endpoint.token));
        assert!(!format!("{endpoint:?}").contains(&endpoint.native_sync_token));
    }

    #[test]
    fn rust_launcher_bootstraps_staged_sidecar_over_stdin_and_reaches_health() {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let staged = manifest_dir.join("resources/sidecar/main.mjs");
        assert!(
            staged.is_file(),
            "run node ../scripts/prepare-package.mjs before this packaged-sidecar smoke test"
        );
        let port = free_port().unwrap();
        let launch_token = random_token();
        let native_sync_token = random_token();
        let endpoint = Endpoint {
            port,
            token: launch_token.clone(),
            native_sync_token: native_sync_token.clone(),
        };
        let log_dir = std::env::temp_dir().join(format!("xyra-bootstrap-{}", random_token()));
        let log = Log::open(&log_dir, "smoke.log");
        let sup = Supervisor::new(
            Launch {
                program: PathBuf::from("node"),
                args: vec![staged.into_os_string()],
                env: vec![
                    ("XYRA_SIDECAR_PORT", port.to_string()),
                    ("XYRA_DATA_DIR", "memory://".into()),
                    ("XYRA_OS_SUBJECT", "smoke:rust-launcher".into()),
                    ("XYRA_DISPLAY_NAME", "Rust launcher smoke".into()),
                    ("XYRA_ALLOWED_ORIGINS", "http://tauri.localhost".into()),
                ],
                launch_token: launch_token.clone(),
                native_sync_token: native_sync_token.clone(),
                cwd: Some(manifest_dir),
            },
            endpoint,
            fast_policy(),
            log.clone(),
            Box::new(move |value| value == launch_token || value == native_sync_token),
        );
        sup.start();
        let ready = match sup.wait_ready(Duration::from_secs(30)) {
            Ok(ready) => ready,
            Err(status) => {
                let contents = log
                    .path()
                    .and_then(|path| std::fs::read_to_string(path).ok())
                    .unwrap_or_default();
                sup.shutdown();
                panic!("sidecar bootstrap failed: {status:?}; launcher log: {contents}");
            }
        };
        assert_eq!(ready.port, port);
        let client = reqwest::blocking::Client::new();
        let response = client
            .get(format!("http://127.0.0.1:{port}/api/v1/session"))
            .header("authorization", format!("Bearer {}", ready.token))
            .header("origin", "http://tauri.localhost")
            .send()
            .expect("staged sidecar health request");
        let body: serde_json::Value = response.json().expect("session response JSON");
        assert_eq!(body["workspaces"].as_array().map(Vec::len), Some(2));

        let callback = format!("http://127.0.0.1:{port}/internal/native/cloud-sync/push");
        let malformed_envelope = r#"{"request":{},"response":{}}"#;
        let forged = client
            .post(&callback)
            .header("content-type", "application/json")
            .header("x-xyra-native-sync-token", random_token())
            .body(malformed_envelope)
            .send()
            .expect("forged native sync callback request");
        assert_eq!(forged.status(), reqwest::StatusCode::FORBIDDEN);
        let forged_body: serde_json::Value = forged.json().expect("forgery refusal JSON");
        assert_eq!(forged_body["code"], "NATIVE_SYNC_ONLY");

        let webview_origin = client
            .post(&callback)
            .header("origin", "http://tauri.localhost")
            .header("content-type", "application/json")
            .header("x-xyra-native-sync-token", &ready.native_sync_token)
            .body(malformed_envelope)
            .send()
            .expect("renderer-origin native sync callback request");
        assert_eq!(webview_origin.status(), reqwest::StatusCode::FORBIDDEN);
        let origin_body: serde_json::Value = webview_origin.json().expect("origin refusal JSON");
        assert_eq!(origin_body["code"], "NATIVE_SYNC_ONLY");

        let native_authenticated = client
            .post(&callback)
            .header("content-type", "application/json")
            .header("x-xyra-native-sync-token", &ready.native_sync_token)
            .body(malformed_envelope)
            .send()
            .expect("authenticated native sync callback request");
        assert_eq!(
            native_authenticated.status(),
            reqwest::StatusCode::BAD_REQUEST
        );
        let native_body: serde_json::Value = native_authenticated
            .json()
            .expect("strict envelope refusal JSON");
        assert_eq!(native_body["code"], "SYNC_ACK_INVALID");
        let native_sender = crate::cloud_service::ReqwestSidecarTransport::new().unwrap();
        assert_eq!(
            native_sender.record_cloud_push(
                port,
                &ready.native_sync_token,
                &serde_json::json!({ "request": {}, "response": {} }),
            ),
            Err("CLOUD_SYNC_ACK_RECORD_FAILED".into())
        );
        sup.shutdown();
        let _ = std::fs::remove_dir_all(log_dir);
    }
}
