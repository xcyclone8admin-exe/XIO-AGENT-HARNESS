//! Native Windows shell (Tauri 2): hosts the static web export in WebView2 and supervises the
//! bundled Node sidecar on a private loopback port (ADR-0008, ARCHITECTURE §13).

mod cloud_auth;
mod cloud_crypto;
mod cloud_service;
mod commands;
mod guardian;
mod identity;
mod job;
mod logging;
mod sidecar;
mod spawn_scoped;
mod tray;
mod updater;
mod window;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{Manager, RunEvent};

use cloud_service::CloudAuthService;
use commands::AppState;
use guardian::GuardianPolicy;
use logging::Log;
use sidecar::{Endpoint, Launch, Supervisor};

/// The only WebView origin the sidecar accepts in packaged builds.
const APP_ORIGIN: &str = "http://tauri.localhost";
/// ADR-0015: sidecar JS heap ceiling.
const SIDECAR_HEAP_MB: u32 = 1536;

pub fn run() {
    let mut context = tauri::generate_context!();
    // Pick the port before the app is built so the CSP names exactly this launch's sidecar. A
    // second instance also reaches here but exits in the single-instance plugin before spawning.
    let port = sidecar::free_port().expect("no free loopback port for the local service");
    window::pin_config_csp(&mut context.config_mut().app.security.csp, port);

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            window::reveal(app)
        }))
        .invoke_handler(tauri::generate_handler![
            commands::sidecar_endpoint,
            commands::sidecar_status,
            commands::sidecar_restart,
            cloud_auth::cloud_auth_begin,
            cloud_auth::cloud_auth_complete,
            cloud_auth::cloud_session_status,
            cloud_auth::cloud_session_logout,
            cloud_auth::cloud_authenticated_request,
            cloud_auth::cloud_blob_upload,
            cloud_auth::cloud_sync_push_to_sidecar,
            updater::update_status,
        ])
        .setup(move |app| {
            let paths = app.path();
            let log_dir = paths.app_log_dir()?;
            let shell_log = Log::open(&log_dir, "shell.log");
            let sidecar_log = Log::open(&log_dir, "sidecar.log");
            let data_dir = paths.app_local_data_dir()?.join("data").join("pglite");
            std::fs::create_dir_all(&data_dir)?;
            let resource_dir = sidecar::strip_verbatim(&paths.resource_dir()?);
            let sidecar_dir = resource_dir.join("sidecar");
            let entry = sidecar_dir.join("main.mjs");
            let node = sidecar::node_binary(&resource_dir);
            shell_log.line(format!(
                "startup version={} commit={}{} port={port} entry_exists={} node={}",
                app.package_info().version,
                env!("XYRA_BUILD_COMMIT"),
                if env!("XYRA_BUILD_DIRTY") == "1" {
                    "-dirty"
                } else {
                    ""
                },
                entry.is_file(),
                node.display(),
            ));

            let token = sidecar::random_token();
            let native_sync_token = sidecar::random_token();
            let launch = Launch {
                program: node,
                args: vec![
                    format!("--max-old-space-size={SIDECAR_HEAP_MB}").into(),
                    entry.into_os_string(),
                ],
                env: vec![
                    ("XYRA_SIDECAR_PORT", port.to_string()),
                    ("XYRA_DATA_DIR", path_string(&data_dir)),
                    ("XYRA_OS_SUBJECT", identity::os_subject()?),
                    ("XYRA_DISPLAY_NAME", identity::display_name()),
                    ("XYRA_ALLOWED_ORIGINS", APP_ORIGIN.to_string()),
                ],
                launch_token: token.clone(),
                native_sync_token: native_sync_token.clone(),
                cwd: Some(sidecar_dir),
            };
            let supervisor = Supervisor::new(
                launch,
                Endpoint {
                    port,
                    token,
                    native_sync_token,
                },
                GuardianPolicy::default(),
                sidecar_log,
                Box::new(|_| false),
            );
            let handle = app.handle().clone();
            supervisor.set_on_ready(Box::new(move |generation| {
                // The page connected to the previous generation; tell it to fetch a fresh session.
                if generation > 1 {
                    if let Some(window) = handle.get_webview_window(window::MAIN) {
                        let _ = window.eval(window::SESSION_READY_SCRIPT);
                    }
                }
            }));
            supervisor.start();
            let cloud_auth =
                Arc::new(CloudAuthService::production().map_err(std::io::Error::other)?);
            app.manage(AppState {
                supervisor: Arc::clone(&supervisor),
                cloud_auth,
            });
            tray::build(app, supervisor)?;
            window::build_main(app.handle(), &shell_log)?;
            Ok(())
        });

    updater::register(builder)
        .build(context)
        .expect("failed to build the desktop shell")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<AppState>() {
                    state.supervisor.shutdown();
                }
            }
        });
}

fn path_string(path: &std::path::Path) -> String {
    sidecar::strip_verbatim(path).to_string_lossy().into_owned()
}

#[allow(dead_code)]
fn _assert_paths_are_owned(_: PathBuf) {}
