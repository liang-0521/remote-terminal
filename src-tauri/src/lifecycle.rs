use crate::{
    backend::{BackendState, ExitPreparation},
    error::{AppError, AppResult},
    state::{AppState, CloseBehavior, WindowPlacement},
};
use serde::Serialize;
use tauri::{
    window::Monitor, AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Runtime,
    WebviewWindow, Window, WindowEvent,
};

pub const CLOSE_REQUESTED_EVENT: &str = "app://close-requested";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloseRequestedPayload {
    request_id: String,
    behavior: CloseBehavior,
    active_session_count: usize,
    active_transfer_count: usize,
}

pub fn restore_main_window<R: Runtime>(app: &AppHandle<R>) -> AppResult<()> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::new("MAIN_WINDOW_UNAVAILABLE", "主窗口当前不可用。"))?;
    if window
        .is_minimized()
        .map_err(|_| AppError::new("MAIN_WINDOW_RESTORE_FAILED", "无法检查主窗口状态。"))?
    {
        window
            .unminimize()
            .map_err(|_| AppError::new("MAIN_WINDOW_RESTORE_FAILED", "无法恢复主窗口。"))?;
    }
    window
        .show()
        .map_err(|_| AppError::new("MAIN_WINDOW_RESTORE_FAILED", "无法显示主窗口。"))?;
    window
        .set_focus()
        .map_err(|_| AppError::new("MAIN_WINDOW_RESTORE_FAILED", "无法聚焦主窗口。"))
}

pub fn hide_main_window<R: Runtime>(app: &AppHandle<R>) -> AppResult<()> {
    app.get_webview_window("main")
        .ok_or_else(|| AppError::new("MAIN_WINDOW_UNAVAILABLE", "主窗口当前不可用。"))?
        .hide()
        .map_err(|_| AppError::new("MAIN_WINDOW_HIDE_FAILED", "无法隐藏主窗口。"))
}

pub fn restore_saved_window_placement<R: Runtime>(app: &AppHandle<R>) -> AppResult<()> {
    let Some(placement) = app
        .state::<AppState>()
        .window_placement()
        .map_err(|_| AppError::new("SETTINGS_READ_FAILED", "无法读取上次的窗口位置。"))?
    else {
        return Ok(());
    };
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::new("MAIN_WINDOW_UNAVAILABLE", "主窗口当前不可用。"))?;
    let monitors = window
        .placement_available_monitors()
        .map_err(|_| AppError::new("WINDOW_PLACEMENT_FAILED", "无法检查可用显示器。"))?;
    if !monitors
        .iter()
        .any(|monitor| placement_intersects_monitor(placement, monitor))
    {
        return Ok(());
    }
    window
        .placement_set_size(PhysicalSize::new(placement.width, placement.height))
        .and_then(|_| {
            window.placement_set_position(PhysicalPosition::new(placement.x, placement.y))
        })
        .map_err(|_| AppError::new("WINDOW_PLACEMENT_FAILED", "无法恢复上次的窗口位置。"))?;
    if placement.maximized {
        window
            .placement_maximize()
            .map_err(|_| AppError::new("WINDOW_PLACEMENT_FAILED", "无法恢复窗口最大化状态。"))?;
    }
    Ok(())
}

/// Used by a saved Exit choice, the tray Exit item, and the explicit quit IPC.
/// A new transfer cannot slip between the active-transfer check and shutdown;
/// BackendState owns that gate. Active work restores the window and delegates
/// the destructive decision to the close confirmation dialog.
pub fn request_exit_with_confirmation<R: Runtime>(app: &AppHandle<R>, behavior: CloseBehavior) {
    let request_id = match app.state::<AppState>().begin_close_request() {
        Ok(request_id) => request_id,
        Err(_) => {
            eprintln!("[remote-terminal] create close request: NATIVE_STATE_FAILED");
            return;
        }
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let preparation = app.state::<BackendState>().prepare_exit(false).await;
        match preparation {
            ExitPreparation::Ready => {
                clear_pending_close_request(&app);
                exit_now(&app);
            }
            ExitPreparation::NeedsConfirmation {
                active_session_count,
                active_transfer_count,
            } => {
                if let Err(error) = restore_main_window(&app) {
                    log_lifecycle_error("restore window for active transfer warning", &error);
                    return;
                }
                emit_close_request(
                    &app,
                    &request_id,
                    behavior,
                    active_session_count,
                    active_transfer_count,
                );
            }
        }
    });
}

/// Called only after the user explicitly confirms Exit in the close dialog.
pub fn confirm_exit<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = app.state::<BackendState>().prepare_exit(true).await;
        exit_now(&app);
    });
}

pub fn handle_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if window.label() != "main" {
        return;
    }

    if matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
        remember_normal_window_placement(&window.state::<AppState>(), window);
        return;
    }

    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };

    persist_window_placement(&window.state::<AppState>(), window);

    let state = window.state::<AppState>();
    if state.is_quitting() {
        return;
    }
    api.prevent_close();

    match state.close_behavior() {
        Ok(CloseBehavior::Background) => {
            clear_pending_close_request(window.app_handle());
            if window.hide().is_err() {
                eprintln!("[remote-terminal] hide main window: MAIN_WINDOW_HIDE_FAILED");
            }
        }
        Ok(CloseBehavior::Exit) => {
            request_exit_with_confirmation(window.app_handle(), CloseBehavior::Exit);
        }
        Ok(CloseBehavior::Ask) => {
            let app = window.app_handle().clone();
            let request_id = match state.begin_close_request() {
                Ok(request_id) => request_id,
                Err(_) => {
                    eprintln!("[remote-terminal] create close request: NATIVE_STATE_FAILED");
                    return;
                }
            };
            tauri::async_runtime::spawn(async move {
                let (active_session_count, active_transfer_count) =
                    app.state::<BackendState>().exit_activity().await;
                emit_close_request(
                    &app,
                    &request_id,
                    CloseBehavior::Ask,
                    active_session_count,
                    active_transfer_count,
                );
            });
        }
        Err(_) => {
            eprintln!("[remote-terminal] read close behavior: SETTINGS_READ_FAILED");
        }
    }
}

fn emit_close_request<R: Runtime>(
    app: &AppHandle<R>,
    request_id: &str,
    behavior: CloseBehavior,
    active_session_count: usize,
    active_transfer_count: usize,
) {
    let state = app.state::<AppState>();
    let emitted = state.with_pending_close_request(request_id, || {
        app.emit(
            CLOSE_REQUESTED_EVENT,
            CloseRequestedPayload {
                request_id: request_id.to_string(),
                behavior,
                active_session_count,
                active_transfer_count,
            },
        )
    });
    match emitted {
        Ok(Some(Ok(()))) | Ok(None) => {}
        Ok(Some(Err(_))) => {
            let _ = state.consume_close_request(request_id);
            eprintln!("[remote-terminal] emit close request: NATIVE_EVENT_EMIT_FAILED");
        }
        Err(_) => {
            eprintln!("[remote-terminal] emit close request: NATIVE_STATE_FAILED");
        }
    }
}

fn exit_now<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        persist_window_placement(&app.state::<AppState>(), &window);
    }
    let state = app.state::<AppState>();
    state.begin_quit();
    app.exit(0);
}

trait WindowPlacementTarget {
    fn placement_outer_position(&self) -> tauri::Result<PhysicalPosition<i32>>;
    fn placement_outer_size(&self) -> tauri::Result<PhysicalSize<u32>>;
    fn placement_is_minimized(&self) -> tauri::Result<bool>;
    fn placement_is_maximized(&self) -> tauri::Result<bool>;
    fn placement_available_monitors(&self) -> tauri::Result<Vec<Monitor>>;
    fn placement_set_position(&self, position: PhysicalPosition<i32>) -> tauri::Result<()>;
    fn placement_set_size(&self, size: PhysicalSize<u32>) -> tauri::Result<()>;
    fn placement_maximize(&self) -> tauri::Result<()>;
}

macro_rules! impl_window_placement_target {
    ($window:ident) => {
        impl<R: Runtime> WindowPlacementTarget for $window<R> {
            fn placement_outer_position(&self) -> tauri::Result<PhysicalPosition<i32>> {
                self.outer_position()
            }

            fn placement_outer_size(&self) -> tauri::Result<PhysicalSize<u32>> {
                self.outer_size()
            }

            fn placement_is_minimized(&self) -> tauri::Result<bool> {
                self.is_minimized()
            }

            fn placement_is_maximized(&self) -> tauri::Result<bool> {
                self.is_maximized()
            }

            fn placement_available_monitors(&self) -> tauri::Result<Vec<Monitor>> {
                self.available_monitors()
            }

            fn placement_set_position(&self, position: PhysicalPosition<i32>) -> tauri::Result<()> {
                self.set_position(position)
            }

            fn placement_set_size(&self, size: PhysicalSize<u32>) -> tauri::Result<()> {
                self.set_size(size)
            }

            fn placement_maximize(&self) -> tauri::Result<()> {
                self.maximize()
            }
        }
    };
}

impl_window_placement_target!(Window);
impl_window_placement_target!(WebviewWindow);

fn remember_normal_window_placement(state: &AppState, window: &impl WindowPlacementTarget) {
    if window.placement_is_minimized().unwrap_or(false)
        || window.placement_is_maximized().unwrap_or(false)
    {
        return;
    }
    let Ok(placement) = current_window_placement(window, false) else {
        return;
    };
    if state.remember_window_placement(placement).is_err() {
        eprintln!("[remote-terminal] remember window placement: NATIVE_STATE_FAILED");
    }
}

fn persist_window_placement(state: &AppState, window: &impl WindowPlacementTarget) {
    let maximized = window.placement_is_maximized().unwrap_or(false);
    let placement = if maximized {
        state
            .window_placement()
            .ok()
            .flatten()
            .map(|mut placement| {
                placement.maximized = true;
                placement
            })
            .or_else(|| current_window_placement(window, true).ok())
    } else {
        current_window_placement(window, false).ok()
    };
    let Some(placement) = placement else {
        return;
    };
    if state.set_window_placement(placement).is_err() {
        eprintln!("[remote-terminal] persist window placement: SETTINGS_WRITE_FAILED");
    }
}

fn current_window_placement(
    window: &impl WindowPlacementTarget,
    maximized: bool,
) -> Result<WindowPlacement, tauri::Error> {
    let position = window.placement_outer_position()?;
    let size = window.placement_outer_size()?;
    Ok(WindowPlacement {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized,
    })
}

fn placement_intersects_monitor(placement: WindowPlacement, monitor: &Monitor) -> bool {
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let window_right = i64::from(placement.x) + i64::from(placement.width);
    let window_bottom = i64::from(placement.y) + i64::from(placement.height);
    let monitor_right = i64::from(monitor_position.x) + i64::from(monitor_size.width);
    let monitor_bottom = i64::from(monitor_position.y) + i64::from(monitor_size.height);
    window_right > i64::from(monitor_position.x) + 64
        && i64::from(placement.x) < monitor_right - 64
        && window_bottom > i64::from(monitor_position.y) + 64
        && i64::from(placement.y) < monitor_bottom - 64
}

fn clear_pending_close_request<R: Runtime>(app: &AppHandle<R>) {
    if app.state::<AppState>().clear_close_request().is_err() {
        eprintln!("[remote-terminal] clear close request: NATIVE_STATE_FAILED");
    }
}

fn log_lifecycle_error(context: &str, error: &AppError) {
    eprintln!("[remote-terminal] {context}: {}", error.code);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_event_exposes_backend_transfer_count() {
        let payload = CloseRequestedPayload {
            request_id: "8f2d624f-36cc-4a81-8724-73b165ea6f5f".to_string(),
            behavior: CloseBehavior::Exit,
            active_session_count: 1,
            active_transfer_count: 2,
        };
        assert_eq!(
            serde_json::to_value(payload).unwrap(),
            serde_json::json!({
                "requestId": "8f2d624f-36cc-4a81-8724-73b165ea6f5f",
                "behavior": "exit",
                "activeSessionCount": 1,
                "activeTransferCount": 2,
            })
        );
    }
}
