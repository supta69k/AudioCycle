#[cfg(windows)]
mod windows;

use serde::Serialize;
use thiserror::Error;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct AudioTelemetry {
    pub peak: f32,
    pub peak_l: f32,
    pub peak_r: f32,
    pub volume: f32,
    pub muted: bool,
    pub active: bool,
}

impl Default for AudioTelemetry {
    fn default() -> Self {
        Self {
            peak: 0.0,
            peak_l: 0.0,
            peak_r: 0.0,
            volume: 0.75,
            muted: false,
            active: false,
        }
    }
}

#[derive(Debug, Error)]
pub enum AudioError {
    #[error("No active audio {0} devices were found.")]
    NoDevices(&'static str),
    #[allow(dead_code)]
    #[error("Audio output switching is currently implemented for Windows.")]
    UnsupportedPlatform,
    #[error("Windows audio API error: {0}")]
    Windows(String),
}

#[cfg(windows)]
pub fn list_outputs() -> Result<Vec<AudioDevice>, AudioError> {
    windows::list_outputs()
}

#[cfg(not(windows))]
pub fn list_outputs() -> Result<Vec<AudioDevice>, AudioError> {
    Err(AudioError::UnsupportedPlatform)
}

#[cfg(windows)]
pub fn cycle_output() -> Result<AudioDevice, AudioError> {
    windows::cycle_output()
}

#[cfg(not(windows))]
pub fn cycle_output() -> Result<AudioDevice, AudioError> {
    Err(AudioError::UnsupportedPlatform)
}

#[cfg(windows)]
pub fn list_inputs() -> Result<Vec<AudioDevice>, AudioError> {
    windows::list_inputs()
}

#[cfg(not(windows))]
pub fn list_inputs() -> Result<Vec<AudioDevice>, AudioError> {
    Err(AudioError::UnsupportedPlatform)
}

#[cfg(windows)]
pub fn cycle_input() -> Result<AudioDevice, AudioError> {
    windows::cycle_input()
}

#[cfg(not(windows))]
pub fn cycle_input() -> Result<AudioDevice, AudioError> {
    Err(AudioError::UnsupportedPlatform)
}

#[cfg(windows)]
pub fn set_output(device_id: &str) -> Result<AudioDevice, AudioError> {
    windows::set_output(device_id)
}

#[cfg(not(windows))]
pub fn set_output(_device_id: &str) -> Result<AudioDevice, AudioError> {
    Err(AudioError::UnsupportedPlatform)
}

#[cfg(windows)]
pub fn set_input(device_id: &str) -> Result<AudioDevice, AudioError> {
    windows::set_input(device_id)
}

#[cfg(not(windows))]
pub fn set_input(_device_id: &str) -> Result<AudioDevice, AudioError> {
    Err(AudioError::UnsupportedPlatform)
}

#[cfg(windows)]
pub fn is_audio_active() -> Result<bool, AudioError> {
    windows::is_audio_active()
}

#[cfg(not(windows))]
pub fn is_audio_active() -> Result<bool, AudioError> {
    Ok(false)
}

#[cfg(windows)]
pub fn get_telemetry(is_input: bool) -> Result<AudioTelemetry, AudioError> {
    windows::get_telemetry(is_input)
}

#[cfg(not(windows))]
pub fn get_telemetry(_is_input: bool) -> Result<AudioTelemetry, AudioError> {
    Ok(AudioTelemetry::default())
}

#[cfg(windows)]
pub fn set_master_volume(is_input: bool, level: f32) -> Result<AudioTelemetry, AudioError> {
    windows::set_master_volume(is_input, level)
}

#[cfg(not(windows))]
pub fn set_master_volume(_is_input: bool, _level: f32) -> Result<AudioTelemetry, AudioError> {
    Err(AudioError::UnsupportedPlatform)
}

#[cfg(windows)]
pub fn set_master_mute(is_input: bool, muted: bool) -> Result<AudioTelemetry, AudioError> {
    windows::set_master_mute(is_input, muted)
}

#[cfg(not(windows))]
pub fn set_master_mute(_is_input: bool, _muted: bool) -> Result<AudioTelemetry, AudioError> {
    Err(AudioError::UnsupportedPlatform)
}

#[cfg(windows)]
pub fn subscribe_device_changes<F>(on_change: F)
where
    F: Fn() + Send + Sync + 'static,
{
    windows::subscribe_device_changes(on_change);
}

#[cfg(not(windows))]
pub fn subscribe_device_changes<F>(_on_change: F)
where
    F: Fn() + Send + Sync + 'static,
{
}
