use serde::Serialize;
use thiserror::Error;

#[derive(Clone, Debug, Serialize)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Debug, Error)]
pub enum AudioError {
    #[error("No active audio {0} devices were found.")]
    NoDevices(&'static str),
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
pub fn is_audio_active() -> Result<bool, AudioError> { Ok(false) }

#[cfg(not(windows))]
pub fn cycle_input() -> Result<AudioDevice, AudioError> {
    Err(AudioError::UnsupportedPlatform)
}

#[cfg(windows)]
mod windows_audio {
    #![allow(non_snake_case)]

    use super::{AudioDevice, AudioError};
    use std::ffi::c_void;
    use windows::{
        core::PCWSTR,
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

    const POLICY_CONFIG_CLIENT: windows::core::GUID =
        windows::core::GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);

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
            if data_flow == eCapture { "Microphone" } else { "Audio Output" },
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
            let policy: IPolicyConfig = CoCreateInstance(&POLICY_CONFIG_CLIENT, None, CLSCTX_ALL)
                .map_err(winerr)?;
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
        unsafe {
            init_com();
            let enumerator = endpoint_enumerator()?;
            let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).map_err(winerr)?;
            let meter: IAudioMeterInformation = device.Activate(CLSCTX_ALL, None).map_err(winerr)?;
            let mut peak = 0.0_f32;
            meter.GetPeakValue(&mut peak).ok().map_err(winerr)?;
            Ok(peak > 0.015)
        }
    }

    fn cycle_device(data_flow: EDataFlow, label: &'static str) -> Result<AudioDevice, AudioError> {
        let devices = list_devices(
            data_flow,
            label,
            if data_flow == eCapture { "Microphone" } else { "Audio Output" },
        )?;
        if devices.is_empty() {
            return Err(AudioError::NoDevices(label));
        }

        let current_index = devices.iter().position(|device| device.is_default).unwrap_or(0);
        let next_index = (current_index + 1) % devices.len();
        let next = devices[next_index].clone();

        unsafe {
            init_com();
            let policy: IPolicyConfig = CoCreateInstance(&POLICY_CONFIG_CLIENT, None, CLSCTX_ALL)
                .map_err(winerr)?;
            let wide_id = to_wide(&next.id);

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
        let device = enumerator.GetDefaultAudioEndpoint(data_flow, eConsole).map_err(winerr)?;
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
        let mut variant = store.GetValue(&PKEY_Device_FriendlyName).map_err(winerr)?;
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
    }

}
