//! Append-only diagnostic log files under the app log directory.
//!
//! Callers log names, codes and states only. Secret values never reach this module: the broker
//! audits by logical id, and sidecar output is the sidecar's already-redacted logger.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Clone)]
pub struct Log {
    path: Option<PathBuf>,
    lock: Arc<Mutex<()>>,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl Log {
    pub fn open(dir: &Path, name: &str) -> Self {
        let path = fs::create_dir_all(dir).ok().map(|_| dir.join(name));
        Self {
            path,
            lock: Arc::new(Mutex::new(())),
        }
    }

    /// A log that discards everything (tests, or no writable log directory).
    pub fn discard() -> Self {
        Self {
            path: None,
            lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub fn line(&self, message: impl AsRef<str>) {
        let Some(path) = &self.path else { return };
        let Ok(_guard) = self.lock.lock() else { return };
        if fs::metadata(path).is_ok_and(|m| m.len() > MAX_BYTES) {
            let _ = fs::rename(path, path.with_extension("log.1"));
        }
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            // One line per entry: embedded newlines from child output are flattened.
            let text = message.as_ref().replace(['\r', '\n'], " ");
            let _ = writeln!(file, "{} {text}", now_ms());
        }
    }
}
