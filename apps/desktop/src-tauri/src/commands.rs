//! Commands the main window may invoke (the complete list is in build.rs and capabilities/main.json).

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::State;

use crate::cloud_service::CloudAuthService;
use crate::guardian::GuardianStatus;
use crate::sidecar::Supervisor;

pub struct AppState {
    pub supervisor: Arc<Supervisor>,
    pub cloud_auth: Arc<CloudAuthService>,
}

#[derive(Serialize)]
pub struct SessionView {
    pub port: u16,
    pub token: String,
}

const READY_WAIT: Duration = Duration::from_secs(60);

/// The WebView's only route to the per-launch token. Waits for the sidecar to be ready so the UI
/// can paint before the local service finishes starting.
#[tauri::command]
pub async fn sidecar_endpoint(state: State<'_, AppState>) -> Result<SessionView, String> {
    let supervisor = Arc::clone(&state.supervisor);
    let outcome = tauri::async_runtime::spawn_blocking(move || supervisor.wait_ready(READY_WAIT))
        .await
        .map_err(|_| "LOCAL_SERVICE_UNAVAILABLE".to_string())?;
    outcome
        .map(|endpoint| SessionView {
            port: endpoint.port,
            token: endpoint.token,
        })
        .map_err(|_| "LOCAL_SERVICE_UNAVAILABLE".to_string())
}

#[tauri::command]
pub fn sidecar_status(state: State<'_, AppState>) -> GuardianStatus {
    state.supervisor.status()
}

#[tauri::command]
pub fn sidecar_restart(state: State<'_, AppState>) -> GuardianStatus {
    state.supervisor.restart()
}
