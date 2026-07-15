use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

const DRAG_PREVIEW_ICON: &[u8] = include_bytes!("../icons/icon.png");

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NativeFileDragOutcome {
    Dropped,
    Cancelled,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeFileDragResult {
    pub outcome: NativeFileDragOutcome,
    pub cache_released: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cleanup_error: Option<AppError>,
}

/// Starts the Windows OLE `DoDragDrop` loop on Tauri's main thread. The file
/// path is supplied only by the Rust-owned download cache, never by WebView
/// input. `drag-rs` is isolated behind `catch_unwind` because its Windows shell
/// adapter contains internal fallible COM calls that currently use `unwrap`.
pub async fn start_native_file_drag(
    app: AppHandle,
    local_path: PathBuf,
) -> AppResult<NativeFileDragResult> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(native_drag_error)?;
    let (sender, receiver) = oneshot::channel();
    app.run_on_main_thread(move || {
        let outcome = Arc::new(Mutex::new(None));
        let callback_outcome = outcome.clone();
        let drag_result = catch_unwind(AssertUnwindSafe(|| {
            drag::start_drag(
                &window,
                drag::DragItem::Files(vec![local_path]),
                drag::Image::Raw(DRAG_PREVIEW_ICON.to_vec()),
                move |result, _cursor_position| {
                    if let Ok(mut current) = callback_outcome.lock() {
                        *current = Some(map_drag_result(result));
                    }
                },
                drag::Options {
                    mode: drag::DragMode::Copy,
                    ..Default::default()
                },
            )
        }));
        let result = match drag_result {
            Ok(Ok(())) => outcome
                .lock()
                .map_err(|_| native_drag_error())
                .and_then(|mut value| value.take().ok_or_else(native_drag_error)),
            Ok(Err(_)) | Err(_) => Err(native_drag_error()),
        }
        .map(|outcome| NativeFileDragResult {
            outcome,
            cache_released: false,
            cleanup_error: None,
        });
        let _ = sender.send(result);
    })
    .map_err(|_| native_drag_error())?;
    receiver.await.map_err(|_| native_drag_error())?
}

fn map_drag_result(result: drag::DragResult) -> NativeFileDragOutcome {
    match result {
        drag::DragResult::Dropped => NativeFileDragOutcome::Dropped,
        drag::DragResult::Cancel => NativeFileDragOutcome::Cancelled,
    }
}

fn native_drag_error() -> AppError {
    AppError::new(
        "NATIVE_FILE_DRAG_FAILED",
        "无法启动 Windows 文件拖放，请重新拖动已准备好的文件。",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drag_result_uses_stable_public_outcomes() {
        assert_eq!(
            map_drag_result(drag::DragResult::Dropped),
            NativeFileDragOutcome::Dropped
        );
        assert_eq!(
            map_drag_result(drag::DragResult::Cancel),
            NativeFileDragOutcome::Cancelled
        );
        assert_eq!(
            serde_json::to_value(NativeFileDragResult {
                outcome: NativeFileDragOutcome::Cancelled,
                cache_released: true,
                cleanup_error: None,
            })
            .unwrap(),
            serde_json::json!({
                "outcome": "cancelled",
                "cacheReleased": true,
            })
        );
    }
}
