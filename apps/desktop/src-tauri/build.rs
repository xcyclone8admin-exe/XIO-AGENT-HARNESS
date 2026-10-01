use std::process::Command;

/// Commands the WebView may invoke. Declaring them here makes Tauri generate one `allow-*`
/// permission per command, so capabilities/main.json is the complete WebView → shell surface.
const WEBVIEW_COMMANDS: &[&str] = &[
    "sidecar_endpoint",
    "sidecar_status",
    "sidecar_restart",
    "secret_set",
    "secret_status",
    "cloud_auth_begin",
    "cloud_auth_complete",
    "cloud_session_status",
    "cloud_session_logout",
    "cloud_authenticated_request",
    "cloud_blob_upload",
    "cloud_sync_push_to_sidecar",
    "update_status",
];

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

fn main() {
    // Build provenance for diagnostics only; a missing git never fails the build.
    let commit = git(&["rev-parse", "HEAD"]).unwrap_or_else(|| "unknown".into());
    let dirty = git(&["status", "--porcelain", "--", ".."]).is_some_and(|s| !s.is_empty());
    println!("cargo:rustc-env=XYRA_BUILD_COMMIT={commit}");
    println!(
        "cargo:rustc-env=XYRA_BUILD_DIRTY={}",
        if dirty { "1" } else { "0" }
    );
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=secret-scopes.json");

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(WEBVIEW_COMMANDS)),
    )
    .expect("tauri build step failed");
}
