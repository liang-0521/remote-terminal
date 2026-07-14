use crate::{lifecycle, state::CloseBehavior};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App,
};

const TRAY_ID: &str = "remote-terminal-tray";
const SHOW_MENU_ID: &str = "tray-show";
const QUIT_MENU_ID: &str = "tray-quit";

pub fn setup(app: &App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, SHOW_MENU_ID, "显示主窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT_MENU_ID, "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(tauri::include_image!("icons/icon.png"))
        .tooltip("Remote Terminal")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            SHOW_MENU_ID => {
                if let Err(error) = lifecycle::restore_main_window(app) {
                    eprintln!(
                        "[remote-terminal] restore window from tray menu: {}",
                        error.code
                    );
                }
            }
            QUIT_MENU_ID => {
                lifecycle::request_exit_with_confirmation(app, CloseBehavior::Exit);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                if let Err(error) = lifecycle::restore_main_window(tray.app_handle()) {
                    eprintln!(
                        "[remote-terminal] restore window from tray icon: {}",
                        error.code
                    );
                }
            }
        })
        .build(app)?;

    Ok(())
}
