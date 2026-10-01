//! Main window: bundled app origin only, CSP pinned to this launch's sidecar port, and a native
//! bridge that hands the WebView its session over Tauri IPC (never a URL, never disk).
//!
//! CSP pinning and the navigation guard are ported from starnet `src-tauri/src/main.rs`
//! (`pin_csp_to_sidecar_port`, `pin_config_csp`, `is_app_navigation`), MIT.

use std::time::Duration;

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::logging::Log;

pub const MAIN: &str = "main";

/// Defines the native bridge for the bundled WebView. It carries no token: local sessions and
/// Cloud requests pass through narrowly scoped Tauri IPC methods granted by capabilities/main.json.
pub const NATIVE_BRIDGE_SCRIPT: &str = r#"(function () {
  if (location.protocol !== 'tauri:' && location.hostname !== 'tauri.localhost') return;
  if (Object.prototype.hasOwnProperty.call(window, 'xyraNative')) return;
  var bridge = Object.freeze({
    getSession: function () {
      var internals = window.__TAURI_INTERNALS__;
      if (!internals || typeof internals.invoke !== 'function') {
        return Promise.reject(new Error('NATIVE_BRIDGE_UNAVAILABLE'));
      }
      return internals.invoke('sidecar_endpoint');
    },
    invoke: function (command, args) {
      if (command !== 'cloud_authenticated_request' && command !== 'cloud_blob_upload' &&
          command !== 'cloud_sync_push_to_sidecar') {
        return Promise.reject(new Error('NATIVE_COMMAND_NOT_ALLOWED'));
      }
      var request = args && args.request;
      if (!request || typeof request !== 'object') {
        return Promise.reject(new Error('NATIVE_REQUEST_INVALID'));
      }
      var safeRequest;
      if (command === 'cloud_sync_push_to_sidecar') {
        if (Object.keys(request).length !== 5 || request.protocolVersion !== 1 ||
            request.schemaVersion !== 'cloud-sync-v1' ||
            typeof request.nodeId !== 'string' || typeof request.idempotencyKey !== 'string' ||
            !Array.isArray(request.changes) || request.changes.length > 500) {
          return Promise.reject(new Error('NATIVE_REQUEST_INVALID'));
        }
        safeRequest = request;
      } else if (command === 'cloud_authenticated_request') {
        if (typeof request.path !== 'string' ||
            (request.method !== 'GET' && request.method !== 'POST')) {
          return Promise.reject(new Error('NATIVE_REQUEST_INVALID'));
        }
        safeRequest = { path: request.path, method: request.method };
        if (Object.prototype.hasOwnProperty.call(request, 'body')) {
          safeRequest.body = request.body;
        }
      } else {
        if (typeof request.name !== 'string' ||
            !Number.isInteger(request.expiresInSec) ||
            typeof request.ingestionId !== 'string' ||
            !Array.isArray(request.bytes) || request.bytes.length > 10485760 ||
            !request.bytes.every(function (byte) {
              return Number.isInteger(byte) && byte >= 0 && byte <= 255;
            })) {
          return Promise.reject(new Error('NATIVE_REQUEST_INVALID'));
        }
        safeRequest = {
          name: request.name,
          expiresInSec: request.expiresInSec,
          ingestionId: request.ingestionId,
          bytes: request.bytes
        };
      }
      var internals = window.__TAURI_INTERNALS__;
      if (!internals || typeof internals.invoke !== 'function') {
        return Promise.reject(new Error('NATIVE_BRIDGE_UNAVAILABLE'));
      }
      return internals.invoke(command, { request: safeRequest });
    }
  });
  Object.defineProperty(window, 'xyraNative', { value: bridge, writable: false, configurable: false });
})();"#;

/// Tells an open page that a respawned sidecar is ready, so it reconnects with a fresh session.
pub const SESSION_READY_SCRIPT: &str = "window.dispatchEvent(new Event('xyra:session-ready'));";

/// The config says `http://127.0.0.1:*`; each launch narrows it to its own port.
const CSP_ANY_LOOPBACK_PORT: &str = "http://127.0.0.1:*";

pub fn pin_csp_to_port(csp: &str, port: u16) -> String {
    csp.replace(CSP_ANY_LOOPBACK_PORT, &format!("http://127.0.0.1:{port}"))
}

pub fn pin_config_csp(csp: &mut Option<tauri::utils::config::Csp>, port: u16) {
    use tauri::utils::config::{Csp, CspDirectiveSources};
    match csp {
        Some(Csp::Policy(policy)) => *policy = pin_csp_to_port(policy, port),
        Some(Csp::DirectiveMap(map)) => {
            for sources in map.values_mut() {
                match sources {
                    CspDirectiveSources::Inline(s) => *s = pin_csp_to_port(s, port),
                    CspDirectiveSources::List(list) => {
                        for s in list.iter_mut() {
                            *s = pin_csp_to_port(s, port);
                        }
                    }
                }
            }
        }
        None => {}
    }
}

/// Only the bundled app may load in the main window.
pub fn is_app_navigation(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

/// wry's defaults, kept when a QA override adds arguments.
const DEFAULT_BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

pub fn build_main<R: Runtime>(app: &AppHandle<R>, log: &Log) -> tauri::Result<WebviewWindow<R>> {
    let title = app.package_info().name.clone();
    let builder = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(1280.0, 832.0)
        .min_inner_size(960.0, 600.0)
        .center()
        .visible(false)
        .initialization_script(NATIVE_BRIDGE_SCRIPT)
        .on_navigation(is_app_navigation)
        .on_new_window(|_url, _features| NewWindowResponse::Deny)
        .on_page_load(|window, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                let _ = window.show();
            }
        });
    // Tauri passes its own WebView2 options, so the ambient variable is not applied by itself.
    // Installed QA sets it to open a loopback CDP port; normal launches never do. The value is
    // not logged.
    let builder = match std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
        Ok(extra) if !extra.trim().is_empty() => {
            log.line("webview: explicit browser-argument override applied");
            builder.additional_browser_args(&format!("{DEFAULT_BROWSER_ARGS} {extra}"))
        }
        _ => builder,
    };
    let window = builder.build()?;
    // Never leave the user without a window if the first load stalls.
    let fallback = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(5));
        if !fallback.is_visible().unwrap_or(true) {
            let _ = fallback.show();
        }
    });
    Ok(window)
}

/// Reveal and focus the main window (tray click, second launch).
pub fn reveal<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(s: &str) -> bool {
        is_app_navigation(&tauri::Url::parse(s).expect("valid url"))
    }

    #[test]
    fn app_origin_is_allowed() {
        assert!(ok("tauri://localhost/index.html"));
        assert!(ok("http://tauri.localhost/ops/"));
        assert!(ok("https://tauri.localhost/index.html?x=1#y"));
    }

    #[test]
    fn foreign_pages_are_refused() {
        assert!(!ok("https://evil.example/login"));
        assert!(!ok("http://127.0.0.1:8787/"));
        assert!(!ok("http://tauri.localhost.evil.example/"));
        assert!(!ok("file:///C:/Users/x/page.html"));
        assert!(!ok("javascript:alert(1)"));
        assert!(!ok("data:text/html,hi"));
    }

    #[test]
    fn csp_is_pinned_to_one_port() {
        let csp = "connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:*; img-src 'self'";
        let pinned = pin_csp_to_port(csp, 51234);
        assert!(pinned.contains("http://127.0.0.1:51234"));
        assert!(!pinned.contains("127.0.0.1:*"));
    }

    #[test]
    fn shipped_config_csp_pins_and_keeps_ipc() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json parses");
        let csp = config["app"]["security"]["csp"]
            .as_str()
            .expect("csp is a string");
        assert!(
            csp.contains(CSP_ANY_LOOPBACK_PORT),
            "config must name the loopback placeholder"
        );
        let pinned = pin_csp_to_port(csp, 40000);
        assert!(
            pinned.contains("connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:40000")
        );
        assert!(pinned.contains("frame-ancestors 'none'"));
        assert_eq!(config["app"]["withGlobalTauri"], false);
    }

    #[test]
    fn bridge_script_never_embeds_a_session() {
        assert!(!NATIVE_BRIDGE_SCRIPT.contains("token"));
        assert!(NATIVE_BRIDGE_SCRIPT.contains("invoke('sidecar_endpoint')"));
        assert!(NATIVE_BRIDGE_SCRIPT.contains("command !== 'cloud_authenticated_request'"));
        assert!(NATIVE_BRIDGE_SCRIPT.contains("command !== 'cloud_blob_upload'"));
        assert!(NATIVE_BRIDGE_SCRIPT.contains("{ request: safeRequest }"));
        assert!(!NATIVE_BRIDGE_SCRIPT.contains("Authorization"));
        assert!(!NATIVE_BRIDGE_SCRIPT.contains("baseURL"));
    }
}
