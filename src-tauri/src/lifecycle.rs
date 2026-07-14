use crate::{
    backend::{BackendState, ExitPreparation},
    error::{AppError, AppResult},
    state::{AppState, CloseBehavior},
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, Window, WindowEvent};

pub const CLOSE_REQUESTED_EVENT: &str = "app://close-requested";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloseRequestedPayload {
    request_id: String,
    behavior: CloseBehavior,
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
                active_transfer_count,
            } => {
                if let Err(error) = restore_main_window(&app) {
                    log_lifecycle_error("restore window for active transfer warning", &error);
                    return;
                }
                emit_close_request(&app, &request_id, behavior, active_transfer_count);
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
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    if window.label() != "main" {
        return;
    }

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
                let active_transfer_count =
                    app.state::<BackendState>().active_transfer_count().await;
                emit_close_request(&app, &request_id, CloseBehavior::Ask, active_transfer_count);
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
    active_transfer_count: usize,
) {
    let state = app.state::<AppState>();
    let emitted = state.with_pending_close_request(request_id, || {
        app.emit(
            CLOSE_REQUESTED_EVENT,
            CloseRequestedPayload {
                request_id: request_id.to_string(),
                behavior,
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
    let state = app.state::<AppState>();
    state.begin_quit();
    app.exit(0);
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
            active_transfer_count: 2,
        };
        assert_eq!(
            serde_json::to_value(payload).unwrap(),
            serde_json::json!({
                "requestId": "8f2d624f-36cc-4a81-8724-73b165ea6f5f",
                "behavior": "exit",
                "activeTransferCount": 2,
            })
        );
    }
}
