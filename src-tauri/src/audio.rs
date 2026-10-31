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
    windows_audio::list_outputs()
}

#[cfg(not(windows))]
pub fn list_outputs() -> Result<Vec<AudioDevice>, AudioError> {
    Err(AudioError::UnsupportedPlatform)
}

#[cfg(windows)]
pub fn cycle_output() -> Result<AudioDevice, AudioError> {
    windows_audio::cycle_output()
}

#[cfg(not(windows))]
pub fn cycle_output() -> Result<AudioDevice, AudioError> {
    Err(AudioError::UnsupportedPlatform)
}

#[cfg(windows)]
pub fn list_inputs() -> Result<Vec<AudioDevice>, AudioError> {
    windows_audio::list_inputs()
}

#[cfg(not(windows))]
pub fn list_inputs() -> Result<Vec<AudioDevice>, AudioError> {
    Err(AudioError::UnsupportedPlatform)
}

#[cfg(windows)]
pub fn cycle_input() -> Result<AudioDevice, AudioError> {
    windows_audio::cycle_input()
}

#[cfg(not(windows))]
pub fn cycle_input() -> Result<AudioDevice, AudioError> {
    Err(AudioError::UnsupportedPlatform)
}

#[cfg(windows)]
pub fn set_output(device_id: &str) -> Result<AudioDevice, AudioError> {
    windows_audio::set_output(device_id)
}

#[cfg(not(windows))]
pub fn set_output(_device_id: &str) -> Result<AudioDevice, AudioError> {
    Err(AudioError::UnsupportedPlatform)
}

#[cfg(windows)]
pub fn set_input(device_id: &str) -> Result<AudioDevice, AudioError> {
    windows_audio::set_input(device_id)
}

#[cfg(not(windows))]
pub fn set_input(_device_id: &str) -> Result<AudioDevice, AudioError> {
    Err(AudioError::UnsupportedPlatform)
}

#[cfg(windows)]
pub fn is_audio_active() -> Result<bool, AudioError> {
    windows_audio::is_audio_active()
}

#[cfg(not(windows))]
pub fn is_audio_active() -> Result<bool, AudioError> {
    Ok(false)
}

#[cfg(windows)]
pub fn get_telemetry(is_input: bool) -> Result<AudioTelemetry, AudioError> {
    windows_audio::get_telemetry(is_input)
}

#[cfg(not(windows))]
pub fn get_telemetry(_is_input: bool) -> Result<AudioTelemetry, AudioError> {
    Ok(AudioTelemetry::default())
}

#[cfg(windows)]
pub fn set_master_volume(is_input: bool, level: f32) -> Result<AudioTelemetry, AudioError> {
    windows_audio::set_master_volume(is_input, level)
}

#[cfg(not(windows))]
pub fn set_master_volume(_is_input: bool, _level: f32) -> Result<AudioTelemetry, AudioError> {
    Err(AudioError::UnsupportedPlatform)
}

#[cfg(windows)]
pub fn set_master_mute(is_input: bool, muted: bool) -> Result<AudioTelemetry, AudioError> {
    windows_audio::set_master_mute(is_input, muted)
}

#[cfg(not(windows))]
pub fn set_master_mute(_is_input: bool, _muted: bool) -> Result<AudioTelemetry, AudioError> {
    Err(AudioError::UnsupportedPlatform)
}

#[cfg(windows)]
mod windows_audio {
    #![allow(non_snake_case)]

    use super::{AudioDevice, AudioError, AudioTelemetry};
    use std::ffi::c_void;
    use windows::{
        core::{GUID, PCWSTR},
        Win32::{
            Devices::FunctionDiscovery::PKEY_Device_FriendlyName,
            Media::Audio::{
                eCapture, eCommunications, eConsole, eMultimedia, eRender, EDataFlow, IMMDevice,
                IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
            },
            System::{
                Com::{
                    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL,
                    COINIT_APARTMENTTHREADED, STGM_READ,
                },
                Com::StructuredStorage::{PropVariantClear, PropVariantToStringAlloc},
            },
        },
    };

    const POLICY_CONFIG_CLIENT: GUID = GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);

    pub fn list_outputs() -> Result<Vec<AudioDevice>, AudioError> {
        list_devices(eRender, "output", "Audio Output")
    }

    pub fn list_inputs() -> Result<Vec<AudioDevice>, AudioError> {
        list_devices(eCapture, "input", "Microphone")
    }

    fn list_devices(
        data_flow: EDataFlow,
        label: &'static str,
        fallback_name: &'static str,
    ) -> Result<Vec<AudioDevice>, AudioError> {
        unsafe {
            init_com();
            let enumerator = endpoint_enumerator()?;
            let default_id = default_device_id(&enumerator, data_flow).unwrap_or_default();
            let collection = enumerator
                .EnumAudioEndpoints(data_flow, DEVICE_STATE_ACTIVE)
                .map_err(winerr)?;

            let count = collection.GetCount().map_err(winerr)?;
            let mut devices = Vec::with_capacity(count as usize);

            for index in 0..count {
                let device = collection.Item(index).map_err(winerr)?;
                let id = device_id(&device)?;
                let name = device_name(&device).unwrap_or_else(|_| fallback_name.to_string());

                devices.push(AudioDevice {
                    is_default: id == default_id,
                    id,
                    name,
                });
            }

            if devices.is_empty() {
                Err(AudioError::NoDevices(label))
            } else {
                Ok(devices)
            }
        }
    }

    pub fn cycle_output() -> Result<AudioDevice, AudioError> {
        cycle_device(eRender, "output")
    }

    pub fn cycle_input() -> Result<AudioDevice, AudioError> {
        cycle_device(eCapture, "input")
    }

    pub fn set_output(device_id: &str) -> Result<AudioDevice, AudioError> {
        set_device_by_id(eRender, "output", device_id)
    }

    pub fn set_input(device_id: &str) -> Result<AudioDevice, AudioError> {
        set_device_by_id(eCapture, "input", device_id)
    }

    fn set_device_by_id(
        data_flow: EDataFlow,
        label: &'static str,
        target_id: &str,
    ) -> Result<AudioDevice, AudioError> {
        let devices = list_devices(
            data_flow,
            label,
            if data_flow == eCapture {
                "Microphone"
            } else {
                "Audio Output"
            },
        )?;
        let target = devices
            .into_iter()
            .find(|d| d.id == target_id)
            .ok_or(AudioError::NoDevices(label))?;

        activate_endpoint(&target.id)?;
        Ok(AudioDevice {
            is_default: true,
            ..target
        })
    }

    fn activate_endpoint(endpoint_id: &str) -> Result<(), AudioError> {
        unsafe {
            init_com();
            let policy: IPolicyConfig =
                CoCreateInstance(&POLICY_CONFIG_CLIENT, None, CLSCTX_ALL).map_err(winerr)?;
            let wide_id = to_wide(endpoint_id);

            policy
                .SetDefaultEndpoint(PCWSTR(wide_id.as_ptr()), eCommunications)
                .ok()
                .map_err(winerr)?;
            policy
                .SetDefaultEndpoint(PCWSTR(wide_id.as_ptr()), eConsole)
                .ok()
                .map_err(winerr)?;
            policy
                .SetDefaultEndpoint(PCWSTR(wide_id.as_ptr()), eMultimedia)
                .ok()
                .map_err(winerr)?;
        }
        Ok(())
    }

    pub fn is_audio_active() -> Result<bool, AudioError> {
        let telemetry = get_telemetry(false)?;
        Ok(telemetry.active)
    }

    pub fn get_telemetry(is_input: bool) -> Result<AudioTelemetry, AudioError> {
        unsafe {
            init_com();
            let enumerator = endpoint_enumerator()?;
            let flow = if is_input { eCapture } else { eRender };
            let device = enumerator
                .GetDefaultAudioEndpoint(flow, eConsole)
                .map_err(winerr)?;

            let mut peak = 0.0_f32;
            let mut peak_l = 0.0_f32;
            let mut peak_r = 0.0_f32;

            if let Ok(meter) = device.Activate::<IAudioMeterInformation>(CLSCTX_ALL, None) {
                let _ = meter.GetPeakValue(&mut peak).ok();
                let mut channels = 0_u32;
                if meter.GetMeteringChannelCount(&mut channels).is_ok() && channels >= 2 {
                    let mut buf = vec![0.0_f32; channels as usize];
                    if meter
                        .GetChannelsPeakValues(channels, buf.as_mut_ptr())
                        .is_ok()
                    {
                        peak_l = buf[0];
                        peak_r = buf[1];
                    }
                } else {
                    peak_l = peak;
                    peak_r = peak;
                }
            }

            let mut volume = 0.75_f32;
            let mut muted_int = 0_i32;

            if let Ok(ep_vol) = device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None) {
                let _ = ep_vol.GetMasterVolumeLevelScalar(&mut volume).ok();
                let _ = ep_vol.GetMute(&mut muted_int).ok();
            }

            let muted = muted_int != 0;
            let clamped_peak = peak.clamp(0.0, 1.0);
            Ok(AudioTelemetry {
                peak: clamped_peak,
                peak_l: peak_l.clamp(0.0, 1.0),
                peak_r: peak_r.clamp(0.0, 1.0),
                volume: volume.clamp(0.0, 1.0),
                muted,
                active: !muted && clamped_peak > 0.012,
            })
        }
    }

    pub fn set_master_volume(is_input: bool, level: f32) -> Result<AudioTelemetry, AudioError> {
        unsafe {
            init_com();
            let enumerator = endpoint_enumerator()?;
            let flow = if is_input { eCapture } else { eRender };
            let device = enumerator
                .GetDefaultAudioEndpoint(flow, eConsole)
                .map_err(winerr)?;
            let ep_vol: IAudioEndpointVolume =
                device.Activate(CLSCTX_ALL, None).map_err(winerr)?;
            let clamped = level.clamp(0.0, 1.0);
            ep_vol
                .SetMasterVolumeLevelScalar(clamped, std::ptr::null())
                .ok()
                .map_err(winerr)?;
            if clamped > 0.005 {
                let _ = ep_vol.SetMute(0, std::ptr::null()).ok();
            }
        }
        get_telemetry(is_input)
    }

    pub fn set_master_mute(is_input: bool, muted: bool) -> Result<AudioTelemetry, AudioError> {
        unsafe {
            init_com();
            let enumerator = endpoint_enumerator()?;
            let flow = if is_input { eCapture } else { eRender };
            let device = enumerator
                .GetDefaultAudioEndpoint(flow, eConsole)
                .map_err(winerr)?;
            let ep_vol: IAudioEndpointVolume =
                device.Activate(CLSCTX_ALL, None).map_err(winerr)?;
            ep_vol
                .SetMute(if muted { 1 } else { 0 }, std::ptr::null())
                .ok()
                .map_err(winerr)?;
        }
        get_telemetry(is_input)
    }

    fn cycle_device(data_flow: EDataFlow, label: &'static str) -> Result<AudioDevice, AudioError> {
        let devices = list_devices(
            data_flow,
            label,
            if data_flow == eCapture {
                "Microphone"
            } else {
                "Audio Output"
            },
        )?;
        if devices.is_empty() {
            return Err(AudioError::NoDevices(label));
        }

        let current_index = devices
            .iter()
            .position(|device| device.is_default)
            .unwrap_or(0);
        let next_index = (current_index + 1) % devices.len();
        let next = devices[next_index].clone();

        activate_endpoint(&next.id)?;

        Ok(AudioDevice {
            is_default: true,
            ..next
        })
    }

    unsafe fn init_com() {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }

    unsafe fn endpoint_enumerator() -> Result<IMMDeviceEnumerator, AudioError> {
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(winerr)
    }

    unsafe fn default_device_id(
        enumerator: &IMMDeviceEnumerator,
        data_flow: EDataFlow,
    ) -> Result<String, AudioError> {
        let device = enumerator
            .GetDefaultAudioEndpoint(data_flow, eConsole)
            .map_err(winerr)?;
        device_id(&device)
    }

    unsafe fn device_id(device: &IMMDevice) -> Result<String, AudioError> {
        let id = device.GetId().map_err(winerr)?;
        let value = id
            .to_string()
            .map_err(|error| AudioError::Windows(error.to_string()))?;
        CoTaskMemFree(Some(id.0 as *const c_void));
        Ok(value)
    }

    unsafe fn device_name(device: &IMMDevice) -> Result<String, AudioError> {
        let store = device.OpenPropertyStore(STGM_READ).map_err(winerr)?;
        let mut variant = store
            .GetValue(&PKEY_Device_FriendlyName)
            .map_err(winerr)?;
        let result = PropVariantToStringAlloc(&variant);
        let _ = PropVariantClear(&mut variant);
        let value = result.map_err(winerr)?;

        let name = value
            .to_string()
            .map_err(|error| AudioError::Windows(error.to_string()))?;
        CoTaskMemFree(Some(value.0 as *const c_void));
        Ok(name)
    }

    fn to_wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn winerr(error: windows::core::Error) -> AudioError {
        AudioError::Windows(error.message().to_string())
    }

    #[windows::core::interface("f8679f50-850a-41cf-9c72-430f290290c8")]
    unsafe trait IPolicyConfig: windows::core::IUnknown {
        unsafe fn GetMixFormat(
            &self,
            device_name: PCWSTR,
            mix_format: *mut *mut c_void,
        ) -> windows::core::HRESULT;
        unsafe fn GetDeviceFormat(
            &self,
            device_name: PCWSTR,
            default: i32,
            device_format: *mut *mut c_void,
        ) -> windows::core::HRESULT;
        unsafe fn ResetDeviceFormat(&self, device_name: PCWSTR) -> windows::core::HRESULT;
        unsafe fn SetDeviceFormat(
            &self,
            device_name: PCWSTR,
            endpoint_format: *const c_void,
            mix_format: *const c_void,
        ) -> windows::core::HRESULT;
        unsafe fn GetProcessingPeriod(
            &self,
            device_name: PCWSTR,
            default: i32,
            default_period: *mut i64,
            minimum_period: *mut i64,
        ) -> windows::core::HRESULT;
        unsafe fn SetProcessingPeriod(
            &self,
            device_name: PCWSTR,
            period: *const i64,
        ) -> windows::core::HRESULT;
        unsafe fn GetShareMode(
            &self,
            device_name: PCWSTR,
            share_mode: *mut c_void,
        ) -> windows::core::HRESULT;
        unsafe fn SetShareMode(
            &self,
            device_name: PCWSTR,
            share_mode: *const c_void,
        ) -> windows::core::HRESULT;
        unsafe fn GetPropertyValue(
            &self,
            device_name: PCWSTR,
            key: *const c_void,
            value: *mut c_void,
        ) -> windows::core::HRESULT;
        unsafe fn SetPropertyValue(
            &self,
            device_name: PCWSTR,
            key: *const c_void,
            value: *const c_void,
        ) -> windows::core::HRESULT;
        unsafe fn SetDefaultEndpoint(
            &self,
            device_name: PCWSTR,
            role: windows::Win32::Media::Audio::ERole,
        ) -> windows::core::HRESULT;
        unsafe fn SetEndpointVisibility(
            &self,
            device_name: PCWSTR,
            visible: i32,
        ) -> windows::core::HRESULT;
    }

    #[windows::core::interface("c02216f6-8c67-4b5b-9d00-d008e73e0064")]
    unsafe trait IAudioMeterInformation: windows::core::IUnknown {
        unsafe fn GetPeakValue(&self, peak_value: *mut f32) -> windows::core::HRESULT;
        unsafe fn GetMeteringChannelCount(&self, channel_count: *mut u32)
            -> windows::core::HRESULT;
        unsafe fn GetChannelsPeakValues(
            &self,
            channel_count: u32,
            peak_values: *mut f32,
        ) -> windows::core::HRESULT;
        unsafe fn QueryHardwareSupport(
            &self,
            hardware_support_mask: *mut u32,
        ) -> windows::core::HRESULT;
    }

    #[windows::core::interface("5cdf2c82-841e-4546-9722-0cf74078229a")]
    unsafe trait IAudioEndpointVolume: windows::core::IUnknown {
        unsafe fn RegisterControlChangeNotify(
            &self,
            notify: *const c_void,
        ) -> windows::core::HRESULT;
        unsafe fn UnregisterControlChangeNotify(
            &self,
            notify: *const c_void,
        ) -> windows::core::HRESULT;
        unsafe fn GetChannelCount(&self, channel_count: *mut u32) -> windows::core::HRESULT;
        unsafe fn SetMasterVolumeLevel(
            &self,
            level_db: f32,
            event_context: *const GUID,
        ) -> windows::core::HRESULT;
        unsafe fn SetMasterVolumeLevelScalar(
            &self,
            level: f32,
            event_context: *const GUID,
        ) -> windows::core::HRESULT;
        unsafe fn GetMasterVolumeLevel(&self, level_db: *mut f32) -> windows::core::HRESULT;
        unsafe fn GetMasterVolumeLevelScalar(&self, level: *mut f32) -> windows::core::HRESULT;
        unsafe fn SetChannelVolumeLevel(
            &self,
            channel: u32,
            level_db: f32,
            event_context: *const GUID,
        ) -> windows::core::HRESULT;
        unsafe fn SetChannelVolumeLevelScalar(
            &self,
            channel: u32,
            level: f32,
            event_context: *const GUID,
        ) -> windows::core::HRESULT;
        unsafe fn GetChannelVolumeLevel(
            &self,
            channel: u32,
            level_db: *mut f32,
        ) -> windows::core::HRESULT;
        unsafe fn GetChannelVolumeLevelScalar(
            &self,
            channel: u32,
            level: *mut f32,
        ) -> windows::core::HRESULT;
        unsafe fn SetMute(
            &self,
            mute: i32,
            event_context: *const GUID,
        ) -> windows::core::HRESULT;
        unsafe fn GetMute(&self, mute: *mut i32) -> windows::core::HRESULT;
    }
}
