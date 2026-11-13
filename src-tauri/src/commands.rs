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

async fn run_audio<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AudioError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| format!("Audio task failed: {e}"))?
        .map_err(format_audio_error)
}

#[tauri::command]
pub async fn list_audio_outputs() -> Result<Vec<AudioDevice>, String> {
    run_audio(audio::list_outputs).await
}

#[tauri::command]
pub async fn cycle_audio_output() -> Result<AudioDevice, String> {
    run_audio(audio::cycle_output).await
}

#[tauri::command]
pub async fn set_audio_output(id: String) -> Result<AudioDevice, String> {
    run_audio(move || audio::set_output(&id)).await
}

#[tauri::command]
pub async fn list_audio_inputs() -> Result<Vec<AudioDevice>, String> {
    run_audio(audio::list_inputs).await
}

#[tauri::command]
pub async fn cycle_audio_input() -> Result<AudioDevice, String> {
    run_audio(audio::cycle_input).await
}

#[tauri::command]
pub async fn set_audio_input(id: String) -> Result<AudioDevice, String> {
    run_audio(move || audio::set_input(&id)).await
}

#[tauri::command]
pub async fn audio_activity() -> Result<bool, String> {
    run_audio(audio::is_audio_active).await
}

#[tauri::command]
pub async fn get_audio_telemetry(mode: Option<String>) -> Result<AudioTelemetry, String> {
    let is_input = matches!(mode.as_deref(), Some("input"));
    run_audio(move || audio::get_telemetry(is_input)).await
}

#[tauri::command]
pub async fn set_device_volume(mode: Option<String>, level: f32) -> Result<AudioTelemetry, String> {
    let is_input = matches!(mode.as_deref(), Some("input"));
    run_audio(move || audio::set_master_volume(is_input, level)).await
}

#[tauri::command]
pub async fn set_device_mute(mode: Option<String>, muted: bool) -> Result<AudioTelemetry, String> {
    let is_input = matches!(mode.as_deref(), Some("input"));
    run_audio(move || audio::set_master_mute(is_input, muted)).await
}

#[tauri::command]
pub async fn get_autostart(app: AppHandle) -> bool {
    tauri::async_runtime::spawn_blocking(move || app.autolaunch().is_enabled().unwrap_or(false))
        .await
        .unwrap_or(false)
}

#[tauri::command]
pub async fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let autostart = app.autolaunch();
        let res = if enabled {
            autostart.enable()
        } else {
            autostart.disable()
        };
        res.map_err(|e| e.to_string())?;
        Ok(autostart.is_enabled().unwrap_or(enabled))
    })
    .await
    .map_err(|e| format!("Autostart update failed: {e}"))?
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
pub async fn list_monitors(app: AppHandle) -> Result<Vec<MonitorBounds>, String> {
    tauri::async_runtime::spawn_blocking(move || {
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
    })
    .await
    .map_err(|e| format!("Monitor enumeration failed: {e}"))?
}
