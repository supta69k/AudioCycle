mod audio;

use audio::{AudioDevice, AudioError};
use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[tauri::command]
fn list_audio_outputs() -> Result<Vec<AudioDevice>, String> {
    audio::list_outputs().map_err(format_audio_error)
}

#[tauri::command]
fn cycle_audio_output() -> Result<AudioDevice, String> {
    audio::cycle_output().map_err(format_audio_error)
}

#[tauri::command]
fn list_audio_inputs() -> Result<Vec<AudioDevice>, String> {
    audio::list_inputs().map_err(format_audio_error)
}

#[tauri::command]
fn cycle_audio_input() -> Result<AudioDevice, String> {
    audio::cycle_input().map_err(format_audio_error)
}

#[tauri::command]
fn audio_activity() -> Result<bool, String> {
    audio::is_audio_active().map_err(format_audio_error)
}

#[cfg(windows)]
fn ensure_single_instance() -> bool {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows::Win32::System::Threading::CreateMutexW;
    let name: Vec<u16> = "AudioCycle.SingleInstance\0".encode_utf16().collect();
    unsafe {
        let Ok(mutex) = CreateMutexW(None, false, PCWSTR(name.as_ptr())) else { return true; };
        let already_running = GetLastError() == ERROR_ALREADY_EXISTS;
        std::mem::forget(mutex);
        !already_running
    }
}

#[cfg(not(windows))]
fn ensure_single_instance() -> bool { true }

#[derive(Serialize)]
struct MonitorBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[tauri::command]
fn list_monitors(app: AppHandle) -> Result<Vec<MonitorBounds>, String> {
    app.available_monitors()
        .map(|monitors| {
            monitors
                .into_iter()
                .map(|monitor| {
                    let position = monitor.position();
                    let size = monitor.size();
                    MonitorBounds {
                        x: position.x,
                        y: position.y,
                        width: size.width,
                        height: size.height,
                    }
                })
                .collect()
        })
        .map_err(|error| error.to_string())
}

fn format_audio_error(error: AudioError) -> String {
    error.to_string()
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_hide = MenuItem::with_id(app, "show_hide", "Hide / Show Widget", true, None::<&str>)?;
    let startup = MenuItem::with_id(app, "startup", "Launch on Startup", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit AudioCycle", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_hide, &startup, &settings, &quit])?;

    TrayIconBuilder::new()
        .tooltip("AudioCycle")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show_hide" => {
                let _ = app.emit("toggle-widget", ());
            }
            "startup" => {
                let autostart = app.autolaunch();
                let _ = if autostart.is_enabled().unwrap_or(false) {
                    autostart.disable()
                } else {
                    autostart.enable()
                };
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

fn setup_shortcuts(app: &AppHandle) -> tauri::Result<()> {
    let shortcut = Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), Code::KeyA);
    if let Err(error) = app.global_shortcut().on_shortcut(shortcut, |app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            let _ = app.emit("toggle-widget", ());
        }
    }) {
        eprintln!("failed to register global shortcut: {error}");
    }

    Ok(())
}

fn start_device_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_signature = String::new();

        loop {
            let output_signature = device_signature(audio::list_outputs().unwrap_or_default());
            let input_signature = device_signature(audio::list_inputs().unwrap_or_default());
            let signature = format!("{output_signature}::{input_signature}");

            if !signature.is_empty() && signature != last_signature {
                last_signature = signature;
                let _ = app.emit("audio-devices-changed", ());
            }

            std::thread::sleep(std::time::Duration::from_secs(3));
        }
    });
}

pub fn run() {
    if handle_cli_command() {
        return;
    }
    if !ensure_single_instance() {
        return;
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--background"]),
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            list_audio_outputs,
            cycle_audio_output,
            list_audio_inputs,
            cycle_audio_input,
            audio_activity,
            list_monitors
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_position(PhysicalPosition::new(0, 180));
            }
            setup_tray(&handle)?;
            setup_shortcuts(&handle)?;
            start_device_watcher(handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run AudioCycle");
}

fn handle_cli_command() -> bool {
    let mut args = std::env::args().skip(1);
    let Some(command) = args.next() else {
        return false;
    };

    let result = match command.as_str() {
        "--cycle-output" | "cycle-output" => audio::cycle_output().map(|_| ()),
        "--cycle-input" | "cycle-input" => audio::cycle_input().map(|_| ()),
        _ => return false,
    };

    if let Err(error) = result {
        eprintln!("AudioCycle command failed: {}", format_audio_error(error));
    }

    true
}

fn device_signature(devices: Vec<AudioDevice>) -> String {
    devices
        .into_iter()
        .map(|device| format!("{}:{}", device.id, device.is_default))
        .collect::<Vec<_>>()
        .join("|")
}
