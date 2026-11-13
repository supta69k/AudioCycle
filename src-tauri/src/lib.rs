mod audio;
mod commands;
mod instance;
mod overlay;
mod tray;

pub use overlay::pin_window_topmost;

use tauri::{Emitter, Manager, PhysicalPosition, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

pub fn run() {
    install_crash_logger();
    if handle_cli_command() {
        return;
    }
    if !instance::ensure_single_instance_or_wake() {
        return;
    }

    tauri::Builder::default()
        .manage(overlay::OverlayState::new())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--background"]),
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::list_audio_outputs,
            commands::cycle_audio_output,
            commands::set_audio_output,
            commands::list_audio_inputs,
            commands::cycle_audio_input,
            commands::set_audio_input,
            commands::audio_activity,
            commands::get_audio_telemetry,
            commands::set_device_volume,
            commands::set_device_mute,
            commands::get_autostart,
            commands::set_autostart,
            commands::set_window_size,
            commands::list_monitors,
            overlay::set_hit_regions
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_position(PhysicalPosition::new(0, 180));
                let overlay_state = app.state::<overlay::OverlayState>();
                overlay::init_overlay(&window, overlay_state.inner());

                let overlay_handle = handle.clone();
                window.on_window_event(move |event| match event {
                    WindowEvent::Focused(false) | WindowEvent::Resized(_) => {
                        overlay_handle
                            .state::<overlay::OverlayState>()
                            .mark_topmost_dirty();
                    }
                    WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
                        let st = overlay_handle.state::<overlay::OverlayState>();
                        st.set_scale_factor(*scale_factor);
                        st.mark_topmost_dirty();
                    }
                    _ => {}
                });

                overlay::spawn_overlay_controller(window.clone(), overlay_state.inner());
            }

            tray::setup_tray(&handle)?;
            tray::setup_shortcuts(&handle)?;

            let wake_handle = handle.clone();
            instance::spawn_wake_listener(move || {
                let _ = wake_handle.emit("show-widget", ());
            });

            audio::subscribe_device_changes(move || {
                let _ = handle.emit("audio-devices-changed", ());
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run AudioCycle");
}

/// Records any panic (thread name, location, message) to
/// `%LOCALAPPDATA%\AudioCycle\crash.log` so silent failures leave evidence.
/// The log is capped at ~64 KB to avoid unbounded growth.
fn install_crash_logger() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(dir) = std::env::var_os("LOCALAPPDATA") {
            let dir = std::path::Path::new(&dir).join("AudioCycle");
            let _ = std::fs::create_dir_all(&dir);
            let path = dir.join("crash.log");
            if std::fs::metadata(&path).map(|m| m.len() > 64 * 1024).unwrap_or(false) {
                let _ = std::fs::remove_file(&path);
            }
            if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
                use std::io::Write;
                let secs = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let thread = std::thread::current();
                let _ = writeln!(
                    file,
                    "[unix={secs}] v{} thread={} {info}",
                    env!("CARGO_PKG_VERSION"),
                    thread.name().unwrap_or("unnamed"),
                );
            }
        }
        default_hook(info);
    }));
}

fn handle_cli_command() -> bool {
    let mut args = std::env::args().skip(1);
    let Some(command) = args.next() else {
        return false;
    };

    match command.as_str() {
        "--cycle-output" | "cycle-output" => {
            if let Err(e) = audio::cycle_output() {
                eprintln!(
                    "AudioCycle command failed: {}",
                    commands::format_audio_error(e)
                );
            }
            true
        }
        "--cycle-input" | "cycle-input" => {
            if let Err(e) = audio::cycle_input() {
                eprintln!(
                    "AudioCycle command failed: {}",
                    commands::format_audio_error(e)
                );
            }
            true
        }
        "--version" | "-V" => {
            println!("AudioCycle {}", env!("CARGO_PKG_VERSION"));
            true
        }
        "--help" | "-h" => {
            println!("Usage: AudioCycle.exe [--cycle-output | --cycle-input | --version]");
            true
        }
        _ => false,
    }
}
