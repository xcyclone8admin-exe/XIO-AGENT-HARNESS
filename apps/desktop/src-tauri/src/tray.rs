//! Tray: open the window, see the local service state, restart it, or quit.
//!
//! Menu shape adapted from starnet `src-tauri/src/main.rs` (tray supervisor, `on_tray_menu`), MIT.

use std::sync::Arc;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Manager};

use crate::commands::AppState;
use crate::guardian::{GuardianStatus, ServiceState};
use crate::sidecar::Supervisor;
use crate::window;

pub fn status_line(status: &GuardianStatus) -> String {
    match status.state {
        ServiceState::Starting => "Local service: starting…".into(),
        ServiceState::Ready => "Local service: running".into(),
        ServiceState::Restarting => match status.next_respawn_in_ms {
            Some(ms) if ms > 0 => format!("Local service: restarting in {}s", ms.div_ceil(1000)),
            _ => "Local service: restarting…".into(),
        },
        ServiceState::Halted => "Local service: stopped after repeated failures".into(),
        ServiceState::Stopped => "Local service: stopped".into(),
    }
}

pub fn build(app: &App, supervisor: Arc<Supervisor>) -> tauri::Result<()> {
    let name = app.package_info().name.clone();
    let open = MenuItem::with_id(app, "open", format!("Open {name}"), true, None::<&str>)?;
    let status = MenuItem::with_id(
        app,
        "status",
        "Local service: starting…",
        false,
        None::<&str>,
    )?;
    let restart = MenuItem::with_id(app, "restart", "Restart local service", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", format!("Quit {name}"), true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &status, &separator, &restart, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main-tray")
        .tooltip(&name)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app: &AppHandle, event| match event.id.as_ref() {
            "open" => window::reveal(app),
            "restart" => {
                if let Some(state) = app.try_state::<AppState>() {
                    let supervisor = Arc::clone(&state.supervisor);
                    std::thread::spawn(move || {
                        supervisor.restart();
                    });
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                window::reveal(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }
    tray.build(app)?;

    // Keep the status line honest against the supervisor's actual state.
    std::thread::spawn(move || {
        let mut last = String::new();
        loop {
            let line = status_line(&supervisor.status());
            if line != last {
                let _ = status.set_text(&line);
                last = line;
            }
            if supervisor.status().state == ServiceState::Stopped {
                break;
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_lines_name_each_state() {
        let mut s = GuardianStatus::default();
        assert!(status_line(&s).contains("starting"));
        s.state = ServiceState::Restarting;
        s.next_respawn_in_ms = Some(1500);
        assert_eq!(status_line(&s), "Local service: restarting in 2s");
        s.state = ServiceState::Halted;
        assert!(status_line(&s).contains("repeated failures"));
    }
}
