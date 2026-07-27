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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct MonitorBounds {
    left: i64,
    top: i64,
    right: i64,
    bottom: i64,
}

const WINDOW_RECOVERY_MARGIN: i64 = 32;

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
    recover_main_window_visibility(&window)?;
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

fn recover_main_window_visibility<R: Runtime>(window: &WebviewWindow<R>) -> AppResult<()> {
    let maximized = window
        .is_maximized()
        .map_err(|_| AppError::new("WINDOW_PLACEMENT_FAILED", "无法读取主窗口状态。"))?;
    let placement = current_window_placement(window, maximized)
        .map_err(|_| AppError::new("WINDOW_PLACEMENT_FAILED", "无法读取主窗口位置。"))?;
    let monitors = window
        .available_monitors()
        .map_err(|_| AppError::new("WINDOW_PLACEMENT_FAILED", "无法检查可用显示器。"))?;
    if monitors
        .iter()
        .any(|monitor| placement_intersects_monitor(placement, monitor))
    {
        return Ok(());
    }
    let primary = window
        .primary_monitor()
        .map_err(|_| AppError::new("WINDOW_PLACEMENT_FAILED", "无法检查主显示器。"))?;
    let target = primary
        .as_ref()
        .or_else(|| monitors.first())
        .ok_or_else(|| AppError::new("WINDOW_PLACEMENT_FAILED", "当前没有可用的显示器。"))?;
    let recovered = recover_window_placement(placement, monitor_bounds(target));
    if maximized {
        window
            .unmaximize()
            .map_err(|_| AppError::new("WINDOW_PLACEMENT_FAILED", "无法恢复主窗口状态。"))?;
    }
    window
        .set_size(PhysicalSize::new(recovered.width, recovered.height))
        .and_then(|_| window.set_position(PhysicalPosition::new(recovered.x, recovered.y)))
        .map_err(|_| AppError::new("WINDOW_PLACEMENT_FAILED", "无法将主窗口移回当前桌面。"))?;
    if maximized {
        window
            .maximize()
            .map_err(|_| AppError::new("WINDOW_PLACEMENT_FAILED", "无法恢复主窗口最大化状态。"))?;
    }
    Ok(())
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
    // A disconnected monitor may leave a saved window completely unreachable.
    // Partially visible positions remain valid so Windows can preserve native
    // edge hiding and layouts that span monitors with different dimensions.
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
        // Never call set_position while Windows is handling a live move. Native
        // dragging must allow partial off-screen placement and cross-monitor
        // transitions without an application-level collision boundary.
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
    placement_intersects_bounds(placement, monitor_bounds(monitor))
}

fn placement_intersects_bounds(placement: WindowPlacement, monitor: MonitorBounds) -> bool {
    window_monitor_intersection_area(placement, monitor) > 0
}

fn monitor_bounds(monitor: &Monitor) -> MonitorBounds {
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    MonitorBounds {
        left: i64::from(monitor_position.x),
        top: i64::from(monitor_position.y),
        right: i64::from(monitor_position.x) + i64::from(monitor_size.width),
        bottom: i64::from(monitor_position.y) + i64::from(monitor_size.height),
    }
}

fn window_bounds(placement: WindowPlacement) -> MonitorBounds {
    MonitorBounds {
        left: i64::from(placement.x),
        top: i64::from(placement.y),
        right: i64::from(placement.x) + i64::from(placement.width),
        bottom: i64::from(placement.y) + i64::from(placement.height),
    }
}

fn window_monitor_intersection_area(placement: WindowPlacement, monitor: MonitorBounds) -> i64 {
    let window = window_bounds(placement);
    let width = window.right.min(monitor.right) - window.left.max(monitor.left);
    let height = window.bottom.min(monitor.bottom) - window.top.max(monitor.top);
    width.max(0) * height.max(0)
}

fn recovery_bounds(monitor: MonitorBounds) -> MonitorBounds {
    let width = (monitor.right - monitor.left).max(1);
    let height = (monitor.bottom - monitor.top).max(1);
    let horizontal_margin = WINDOW_RECOVERY_MARGIN.min(width.saturating_sub(1) / 2);
    let vertical_margin = WINDOW_RECOVERY_MARGIN.min(height.saturating_sub(1) / 2);
    MonitorBounds {
        left: monitor.left + horizontal_margin,
        top: monitor.top + vertical_margin,
        right: monitor.right - horizontal_margin,
        bottom: monitor.bottom - vertical_margin,
    }
}

fn physical_coordinate(value: i64) -> i32 {
    value.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

fn recover_window_placement(placement: WindowPlacement, monitor: MonitorBounds) -> WindowPlacement {
    let target = recovery_bounds(monitor);
    let available_width = (target.right - target.left).max(1);
    let available_height = (target.bottom - target.top).max(1);
    let width = placement.width.min(available_width as u32);
    let height = placement.height.min(available_height as u32);
    let x = target.left + (available_width - i64::from(width)) / 2;
    let y = target.top + (available_height - i64::from(height)) / 2;
    WindowPlacement {
        x: physical_coordinate(x),
        y: physical_coordinate(y),
        width,
        height,
        maximized: placement.maximized,
    }
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

    fn placement(x: i32, y: i32, width: u32, height: u32) -> WindowPlacement {
        WindowPlacement {
            x,
            y,
            width,
            height,
            maximized: false,
        }
    }

    fn monitor(left: i64, top: i64, width: i64, height: i64) -> MonitorBounds {
        MonitorBounds {
            left,
            top,
            right: left + width,
            bottom: top + height,
        }
    }

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

    #[test]
    fn partially_offscreen_window_remains_restorable() {
        let primary = monitor(0, 0, 1920, 1080);
        assert!(placement_intersects_bounds(
            placement(-28, 40, 1440, 900),
            primary
        ));
        assert!(placement_intersects_bounds(
            placement(1700, 800, 500, 500),
            primary
        ));
    }

    #[test]
    fn fully_offscreen_window_is_not_restored() {
        let primary = monitor(0, 0, 1920, 1080);
        assert!(!placement_intersects_bounds(
            placement(-500, 40, 400, 400),
            primary
        ));
        assert!(!placement_intersects_bounds(
            placement(1920, 0, 500, 500),
            primary
        ));
        assert!(!placement_intersects_bounds(
            placement(0, 1080, 500, 500),
            primary
        ));
    }

    #[test]
    fn disconnected_monitor_window_is_centered_and_fitted_on_primary() {
        let recovered =
            recover_window_placement(placement(2565, 0, 2582, 1445), monitor(0, 0, 2048, 1280));
        assert_eq!(
            recovered,
            WindowPlacement {
                x: 32,
                y: 32,
                width: 1984,
                height: 1216,
                maximized: false,
            }
        );
    }

    #[test]
    fn disconnected_monitor_window_keeps_usable_size_when_centered() {
        let recovered =
            recover_window_placement(placement(2400, 100, 1440, 900), monitor(0, 0, 2048, 1280));
        assert_eq!(
            recovered,
            WindowPlacement {
                x: 304,
                y: 190,
                width: 1440,
                height: 900,
                maximized: false,
            }
        );
    }

    #[test]
    fn window_can_span_monitors_with_different_heights() {
        let primary = monitor(0, 0, 2048, 1280);
        let secondary = monitor(2048, 0, 2048, 1152);
        let spanning = placement(1700, 500, 1000, 900);
        assert!(placement_intersects_bounds(spanning, primary));
        assert!(placement_intersects_bounds(spanning, secondary));
    }

    #[test]
    fn negative_coordinate_monitor_is_a_valid_desktop_region() {
        let secondary = monitor(-1920, 0, 1920, 1080);
        assert!(placement_intersects_bounds(
            placement(-1800, 100, 1200, 800),
            secondary
        ));
    }
}
