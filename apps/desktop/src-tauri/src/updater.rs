//! The updater plugin is compiled into the shell but never registered. There is no endpoint and
//! no public key in any config until distribution and code signing are approved (ADR-0008); turning
//! it on is a reviewed change to this file plus `plugins.updater` in tauri.conf.json.

use serde::Serialize;
use tauri::{Builder, Runtime};

pub const UPDATER_ENABLED: bool = false;
const DISABLED_REASON: &str =
    "Updates are disabled in this build until distribution and signing are approved.";

pub fn register<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    if UPDATER_ENABLED {
        builder.plugin(tauri_plugin_updater::Builder::new().build())
    } else {
        builder
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub enabled: bool,
    pub reason: &'static str,
}

#[tauri::command]
pub fn update_status() -> UpdateStatus {
    UpdateStatus {
        enabled: UPDATER_ENABLED,
        reason: DISABLED_REASON,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn updater_is_off_and_config_has_no_endpoint_or_key() {
        assert!(!super::UPDATER_ENABLED);
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert!(
            config["plugins"].get("updater").is_none(),
            "no updater endpoint or pubkey may ship"
        );
        assert_eq!(config["bundle"]["createUpdaterArtifacts"], false);
    }
}
