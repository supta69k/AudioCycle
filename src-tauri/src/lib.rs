mod audio;
mod commands;
mod instance;
mod overlay;
mod tray;

pub use overlay::pin_window_topmost;

use tauri::{Emitter, Manager, PhysicalPosition, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

pub fn run() {
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
                pin_window_topmost(&window);

                let win_for_events = window.clone();
                window.on_window_event(move |event| match event {
                    WindowEvent::Focused(false)
                    | WindowEvent::Resized(_)
                    | WindowEvent::Moved(_) => {
                        pin_window_topmost(&win_for_events);
                    }
                    _ => {}
                });

                overlay::spawn_overlay_controller(
                    window.clone(),
                    app.state::<overlay::OverlayState>().inner(),
                );
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
