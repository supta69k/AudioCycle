use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let cycle_now = MenuItem::with_id(app, "cycle_now", "Cycle Output Device", true, None::<&str>)?;
    let show_hide = MenuItem::with_id(app, "show_hide", "Hide / Show Widget", true, None::<&str>)?;
    let startup = MenuItem::with_id(app, "startup", "Launch on Startup", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Open Panel", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit AudioCycle", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&cycle_now, &show_hide, &startup, &settings, &quit])?;

    let mut builder = TrayIconBuilder::new()
        .tooltip("AudioCycle")
        .menu(&menu)
        .show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder
        .on_menu_event(|app, event| match event.id.as_ref() {
            "cycle_now" => {
                let _ = app.emit("cycle-active-shortcut", ());
            }
            "show_hide" => {
                let _ = app.emit("toggle-widget", ());
            }
            "startup" => {
                let app_handle = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let autostart = app_handle.autolaunch();
                    let next = !autostart.is_enabled().unwrap_or(false);
                    let _ = if next {
                        autostart.enable()
                    } else {
                        autostart.disable()
                    };
                    let actual = autostart.is_enabled().unwrap_or(next);
                    let _ = app_handle.emit("autostart-changed", actual);
                });
            }
            "settings" => {
                let _ = app.emit("open-settings", ());
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
                let _ = tray.app_handle().emit("toggle-widget", ());
            }
        })
        .build(app)?;

    Ok(())
}

pub fn setup_shortcuts(app: &AppHandle) -> tauri::Result<()> {
    let toggle_shortcut = Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), Code::KeyA);
    if let Err(error) =
        app.global_shortcut()
            .on_shortcut(toggle_shortcut, |app, _shortcut, event| {
                if event.state() == ShortcutState::Pressed {
                    let _ = app.emit("toggle-widget", ());
                }
            })
    {
        eprintln!("failed to register toggle global shortcut: {error}");
    }

    let cycle_shortcut = Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), Code::KeyC);
    if let Err(error) =
        app.global_shortcut()
            .on_shortcut(cycle_shortcut, |app, _shortcut, event| {
                if event.state() == ShortcutState::Pressed {
                    let _ = app.emit("cycle-active-shortcut", ());
                }
            })
    {
        eprintln!("failed to register cycle global shortcut: {error}");
    }

    let panel_shortcut = Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), Code::KeyS);
    if let Err(error) =
        app.global_shortcut()
            .on_shortcut(panel_shortcut, |app, _shortcut, event| {
                if event.state() == ShortcutState::Pressed {
                    let _ = app.emit("toggle-panel", ());
                }
            })
    {
        eprintln!("failed to register panel global shortcut: {error}");
    }

    Ok(())
}
