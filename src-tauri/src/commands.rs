use crate::audio::{self, AudioDevice, AudioError, AudioTelemetry};
use serde::Serialize;
use tauri::{AppHandle, LogicalSize, Manager};
use tauri_plugin_autostart::ManagerExt;

#[derive(Serialize)]
pub struct MonitorBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

pub fn format_audio_error(error: AudioError) -> String {
    error.to_string()
}

#[tauri::command]
pub fn list_audio_outputs() -> Result<Vec<AudioDevice>, String> {
    audio::list_outputs().map_err(format_audio_error)
}

#[tauri::command]
pub fn cycle_audio_output() -> Result<AudioDevice, String> {
    audio::cycle_output().map_err(format_audio_error)
}

#[tauri::command]
pub fn set_audio_output(id: String) -> Result<AudioDevice, String> {
    audio::set_output(&id).map_err(format_audio_error)
}

#[tauri::command]
pub fn list_audio_inputs() -> Result<Vec<AudioDevice>, String> {
    audio::list_inputs().map_err(format_audio_error)
}

#[tauri::command]
pub fn cycle_audio_input() -> Result<AudioDevice, String> {
    audio::cycle_input().map_err(format_audio_error)
}

#[tauri::command]
pub fn set_audio_input(id: String) -> Result<AudioDevice, String> {
    audio::set_input(&id).map_err(format_audio_error)
}

#[tauri::command]
pub fn audio_activity() -> Result<bool, String> {
    audio::is_audio_active().map_err(format_audio_error)
}

#[tauri::command]
pub fn get_audio_telemetry(mode: Option<String>) -> Result<AudioTelemetry, String> {
    let is_input = matches!(mode.as_deref(), Some("input"));
    audio::get_telemetry(is_input).map_err(format_audio_error)
}

#[tauri::command]
pub fn set_device_volume(mode: Option<String>, level: f32) -> Result<AudioTelemetry, String> {
    let is_input = matches!(mode.as_deref(), Some("input"));
    audio::set_master_volume(is_input, level).map_err(format_audio_error)
}

#[tauri::command]
pub fn set_device_mute(mode: Option<String>, muted: bool) -> Result<AudioTelemetry, String> {
    let is_input = matches!(mode.as_deref(), Some("input"));
    audio::set_master_mute(is_input, muted).map_err(format_audio_error)
}

#[tauri::command]
pub fn get_autostart(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let autostart = app.autolaunch();
    let res = if enabled {
        autostart.enable()
    } else {
        autostart.disable()
    };
    res.map_err(|e| e.to_string())?;
    Ok(autostart.is_enabled().unwrap_or(enabled))
}

#[tauri::command]
pub fn set_window_size(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window
            .set_size(LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        crate::pin_window_topmost(&window);
    }
    Ok(())
}

#[tauri::command]
pub fn list_monitors(app: AppHandle) -> Result<Vec<MonitorBounds>, String> {
    app.available_monitors()
        .map(|monitors| {
            monitors
                .into_iter()
                .map(|monitor| {
                    let position = monitor.position();
                    let size = monitor.size();
                    let scale = monitor.scale_factor().max(1.0);
                    MonitorBounds {
                        x: (position.x as f64 / scale).round() as i32,
                        y: (position.y as f64 / scale).round() as i32,
                        width: (size.width as f64 / scale).round() as u32,
                        height: (size.height as f64 / scale).round() as u32,
                    }
                })
                .collect()
        })
        .map_err(|error| error.to_string())
}
