#![allow(non_snake_case)]

use super::{AudioDevice, AudioError, AudioTelemetry};
use std::{
    ffi::c_void,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Sender, SyncSender},
        Arc, Condvar, Mutex, OnceLock,
    },
    time::Duration,
};
use windows::{
    core::{implement, GUID, PCWSTR},
    Win32::{
        Devices::FunctionDiscovery::PKEY_Device_FriendlyName,
        Media::Audio::{
            eCapture, eCommunications, eConsole, eMultimedia, eRender, EDataFlow, ERole,
            IMMDevice, IMMDeviceEnumerator, IMMNotificationClient, IMMNotificationClient_Impl,
            MMDeviceEnumerator, DEVICE_STATE, DEVICE_STATE_ACTIVE,
        },
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
                COINIT, COINIT_MULTITHREADED, STGM_READ,
            },
            Com::StructuredStorage::{PropVariantClear, PropVariantToStringAlloc},
        },
        UI::Shell::PropertiesSystem::PROPERTYKEY,
    },
};

const POLICY_CONFIG_CLIENT: GUID = GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);

/// Monotonic generation counter incremented whenever endpoints or default roles change.
static ENDPOINT_GENERATION: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
struct DeviceListCache {
    outputs: Option<(u64, Vec<AudioDevice>)>,
    inputs: Option<(u64, Vec<AudioDevice>)>,
}

static DEVICE_CACHE: OnceLock<Mutex<DeviceListCache>> = OnceLock::new();
/// Sender to the current audio worker. Replaced with a fresh worker if the
/// existing one wedges inside a stalled driver call or dies.
static AUDIO_WORKER: Mutex<Option<Sender<AudioRequest>>> = Mutex::new(None);
/// Upper bound for any single WASAPI operation before we give up and respawn.
const AUDIO_WORKER_TIMEOUT: Duration = Duration::from_millis(4000);

fn device_cache() -> &'static Mutex<DeviceListCache> {
    DEVICE_CACHE.get_or_init(|| Mutex::new(DeviceListCache::default()))
}

fn bump_generation() {
    ENDPOINT_GENERATION.fetch_add(1, Ordering::AcqRel);
}

/// Ensures paired `CoInitializeEx` / `CoUninitialize` lifetime on dedicated background threads.
struct ComApartmentGuard {
    should_uninit: bool,
}

impl ComApartmentGuard {
    unsafe fn enter(coinit: COINIT) -> Self {
        let hr = CoInitializeEx(None, coinit);
        Self {
            should_uninit: hr.is_ok(),
        }
    }
}

impl Drop for ComApartmentGuard {
    fn drop(&mut self) {
        if self.should_uninit {
            unsafe {
                CoUninitialize();
            }
        }
    }
}

struct EndpointSession {
    generation: u64,
    meter: Option<IAudioMeterInformation>,
    volume: Option<IAudioEndpointVolume>,
}

#[derive(Default)]
struct AudioWorkerCache {
    enumerator: Option<IMMDeviceEnumerator>,
    policy: Option<IPolicyConfig>,
    output_session: Option<EndpointSession>,
    input_session: Option<EndpointSession>,
}

impl AudioWorkerCache {
    unsafe fn ensure_enumerator(&mut self) -> Result<IMMDeviceEnumerator, AudioError> {
        if let Some(ref enumerator) = self.enumerator {
            return Ok(enumerator.clone());
        }
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(winerr)?;
        self.enumerator = Some(enumerator.clone());
        Ok(enumerator)
    }

    unsafe fn ensure_policy(&mut self) -> Result<IPolicyConfig, AudioError> {
        if let Some(ref policy) = self.policy {
            return Ok(policy.clone());
        }
        let policy: IPolicyConfig =
            CoCreateInstance(&POLICY_CONFIG_CLIENT, None, CLSCTX_ALL).map_err(winerr)?;
        self.policy = Some(policy.clone());
        Ok(policy)
    }

    unsafe fn ensure_session(&mut self, is_input: bool) -> Result<&EndpointSession, AudioError> {
        let current_gen = ENDPOINT_GENERATION.load(Ordering::Acquire);
        let slot_matches = match if is_input {
            &self.input_session
        } else {
            &self.output_session
        } {
            Some(s) => s.generation == current_gen,
            None => false,
        };

        if !slot_matches {
            let flow = if is_input { eCapture } else { eRender };
            let enumerator = self.ensure_enumerator()?;
            let device_opt = enumerator.GetDefaultAudioEndpoint(flow, eConsole).ok();
            let (meter, volume) = if let Some(ref device) = device_opt {
                (
                    device.Activate::<IAudioMeterInformation>(CLSCTX_ALL, None).ok(),
                    device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None).ok(),
                )
            } else {
                (None, None)
            };
            let session = EndpointSession {
                generation: current_gen,
                meter,
                volume,
            };
            if is_input {
                self.input_session = Some(session);
            } else {
                self.output_session = Some(session);
            }
        }

        let slot = if is_input {
            self.input_session.as_ref()
        } else {
            self.output_session.as_ref()
        };
        slot.ok_or_else(|| AudioError::Windows("Audio session unavailable".into()))
    }

    fn invalidate(&mut self, is_input: bool) {
        if is_input {
            self.input_session = None;
        } else {
            self.output_session = None;
        }
    }
}

enum AudioRequest {
    ListOutputs(SyncSender<Result<Vec<AudioDevice>, AudioError>>),
    ListInputs(SyncSender<Result<Vec<AudioDevice>, AudioError>>),
    CycleOutput(SyncSender<Result<AudioDevice, AudioError>>),
    CycleInput(SyncSender<Result<AudioDevice, AudioError>>),
    SetOutput(String, SyncSender<Result<AudioDevice, AudioError>>),
    SetInput(String, SyncSender<Result<AudioDevice, AudioError>>),
    GetTelemetry(bool, SyncSender<Result<AudioTelemetry, AudioError>>),
    SetVolume(bool, f32, SyncSender<Result<AudioTelemetry, AudioError>>),
    SetMute(bool, bool, SyncSender<Result<AudioTelemetry, AudioError>>),
}

fn spawn_audio_worker() -> Option<Sender<AudioRequest>> {
    let (tx, rx) = mpsc::channel::<AudioRequest>();
    std::thread::Builder::new()
        .name("audiocycle-audio-worker".into())
        .spawn(move || unsafe {
            // Worker threads without a Win32 message loop MUST use MTA (COINIT_MULTITHREADED)
            // so COM never creates an unpumped OleMainThreadWndClass STA window.
            let _com = ComApartmentGuard::enter(COINIT_MULTITHREADED);
            let mut cache = AudioWorkerCache::default();
            while let Ok(req) = rx.recv() {
                // A panic inside one request must never take down the whole app:
                // drop the reply (caller sees an error) and rebuild COM state.
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    handle_audio_request(&mut cache, req)
                }));
                if outcome.is_err() {
                    cache = AudioWorkerCache::default();
                }
            }
        })
        .ok()
        .map(|_| tx)
}

fn current_worker() -> Option<Sender<AudioRequest>> {
    let mut slot = AUDIO_WORKER.lock().unwrap_or_else(|p| p.into_inner());
    if slot.is_none() {
        *slot = spawn_audio_worker();
    }
    slot.clone()
}

fn reset_worker() {
    let mut slot = AUDIO_WORKER.lock().unwrap_or_else(|p| p.into_inner());
    // Dropping the sender lets the old (possibly wedged) thread exit once it unblocks.
    *slot = None;
}

unsafe fn handle_audio_request(cache: &mut AudioWorkerCache, req: AudioRequest) {
    match req {
        AudioRequest::ListOutputs(reply) => {
            let _ = reply.send(list_outputs_cached(cache));
        }
        AudioRequest::ListInputs(reply) => {
            let _ = reply.send(list_inputs_cached(cache));
        }
        AudioRequest::CycleOutput(reply) => {
            let _ = reply.send(cycle_device_with(cache, eRender, "output"));
        }
        AudioRequest::CycleInput(reply) => {
            let _ = reply.send(cycle_device_with(cache, eCapture, "input"));
        }
        AudioRequest::SetOutput(id, reply) => {
            let _ = reply.send(set_device_by_id_with(cache, eRender, "output", &id));
        }
        AudioRequest::SetInput(id, reply) => {
            let _ = reply.send(set_device_by_id_with(cache, eCapture, "input", &id));
        }
        AudioRequest::GetTelemetry(is_input, reply) => {
            let _ = reply.send(get_telemetry_with(cache, is_input));
        }
        AudioRequest::SetVolume(is_input, level, reply) => {
            let _ = reply.send(set_master_volume_with(cache, is_input, level));
        }
        AudioRequest::SetMute(is_input, muted, reply) => {
            let _ = reply.send(set_master_mute_with(cache, is_input, muted));
        }
    }
}

fn dispatch_worker<T>(make_req: impl FnOnce(SyncSender<Result<T, AudioError>>) -> AudioRequest) -> Result<T, AudioError> {
    let (reply_tx, reply_rx) = mpsc::sync_channel(1);
    let Some(tx) = current_worker() else {
        return Err(AudioError::Windows("Audio worker unavailable".into()));
    };
    if tx.send(make_req(reply_tx)).is_err() {
        reset_worker();
        return Err(AudioError::Windows("Audio worker unavailable".into()));
    }
    match reply_rx.recv_timeout(AUDIO_WORKER_TIMEOUT) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            // The audio driver is stalled; abandon this worker so future calls stay responsive.
            reset_worker();
            Err(AudioError::Windows("Audio driver did not respond in time".into()))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            reset_worker();
            Err(AudioError::Windows("Audio worker dropped response".into()))
        }
    }
}

pub fn list_outputs() -> Result<Vec<AudioDevice>, AudioError> {
    dispatch_worker(AudioRequest::ListOutputs)
}

pub fn list_inputs() -> Result<Vec<AudioDevice>, AudioError> {
    dispatch_worker(AudioRequest::ListInputs)
}

pub fn cycle_output() -> Result<AudioDevice, AudioError> {
    dispatch_worker(AudioRequest::CycleOutput)
}

pub fn cycle_input() -> Result<AudioDevice, AudioError> {
    dispatch_worker(AudioRequest::CycleInput)
}

pub fn set_output(device_id: &str) -> Result<AudioDevice, AudioError> {
    let id = device_id.to_string();
    dispatch_worker(|reply| AudioRequest::SetOutput(id, reply))
}

pub fn set_input(device_id: &str) -> Result<AudioDevice, AudioError> {
    let id = device_id.to_string();
    dispatch_worker(|reply| AudioRequest::SetInput(id, reply))
}

pub fn is_audio_active() -> Result<bool, AudioError> {
    Ok(get_telemetry(false)?.active)
}

pub fn get_telemetry(is_input: bool) -> Result<AudioTelemetry, AudioError> {
    dispatch_worker(|reply| AudioRequest::GetTelemetry(is_input, reply))
}

pub fn set_master_volume(is_input: bool, level: f32) -> Result<AudioTelemetry, AudioError> {
    dispatch_worker(|reply| AudioRequest::SetVolume(is_input, level, reply))
}

pub fn set_master_mute(is_input: bool, muted: bool) -> Result<AudioTelemetry, AudioError> {
    dispatch_worker(|reply| AudioRequest::SetMute(is_input, muted, reply))
}

fn list_outputs_cached(cache: &mut AudioWorkerCache) -> Result<Vec<AudioDevice>, AudioError> {
    let gen = ENDPOINT_GENERATION.load(Ordering::Acquire);
    if let Ok(guard) = device_cache().lock() {
        if let Some((cached_gen, ref list)) = guard.outputs {
            if cached_gen == gen {
                return Ok(list.clone());
            }
        }
    }

    let list = query_devices(cache, eRender, "output", "Audio Output")?;
    if let Ok(mut guard) = device_cache().lock() {
        guard.outputs = Some((gen, list.clone()));
    }
    Ok(list)
}

fn list_inputs_cached(cache: &mut AudioWorkerCache) -> Result<Vec<AudioDevice>, AudioError> {
    let gen = ENDPOINT_GENERATION.load(Ordering::Acquire);
    if let Ok(guard) = device_cache().lock() {
        if let Some((cached_gen, ref list)) = guard.inputs {
            if cached_gen == gen {
                return Ok(list.clone());
            }
        }
    }

    let list = query_devices(cache, eCapture, "input", "Microphone")?;
    if let Ok(mut guard) = device_cache().lock() {
        guard.inputs = Some((gen, list.clone()));
    }
    Ok(list)
}

fn query_devices(
    cache: &mut AudioWorkerCache,
    data_flow: EDataFlow,
    label: &'static str,
    fallback_name: &'static str,
) -> Result<Vec<AudioDevice>, AudioError> {
    unsafe {
        let enumerator = cache.ensure_enumerator()?;
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

fn set_device_by_id_with(
    cache: &mut AudioWorkerCache,
    data_flow: EDataFlow,
    label: &'static str,
    target_id: &str,
) -> Result<AudioDevice, AudioError> {
    let devices = if data_flow == eCapture {
        list_inputs_cached(cache)?
    } else {
        list_outputs_cached(cache)?
    };
    let target = devices
        .into_iter()
        .find(|d| d.id == target_id)
        .ok_or(AudioError::NoDevices(label))?;

    activate_endpoint(cache, &target.id)?;
    Ok(AudioDevice {
        is_default: true,
        ..target
    })
}

fn activate_endpoint(cache: &mut AudioWorkerCache, endpoint_id: &str) -> Result<(), AudioError> {
    unsafe {
        let policy = cache.ensure_policy()?;
        let wide_id = to_wide(endpoint_id);

        let mut success = false;
        let mut last_err = None;

        for role in [eConsole, eMultimedia, eCommunications] {
            match policy.SetDefaultEndpoint(PCWSTR(wide_id.as_ptr()), role).ok() {
                Ok(_) => success = true,
                Err(e) => last_err = Some(e),
            }
        }

        if !success {
            cache.policy = None;
            if let Some(err) = last_err {
                return Err(winerr(err));
            }
        }
    }
    bump_generation();
    Ok(())
}

fn get_telemetry_with(
    cache: &mut AudioWorkerCache,
    is_input: bool,
) -> Result<AudioTelemetry, AudioError> {
    unsafe {
        if let Ok(res) = read_cached_telemetry(cache, is_input, true) {
            return Ok(res);
        }
        cache.invalidate(is_input);
        read_cached_telemetry(cache, is_input, false)
    }
}

unsafe fn read_cached_telemetry(
    cache: &mut AudioWorkerCache,
    is_input: bool,
    strict_meter: bool,
) -> Result<AudioTelemetry, AudioError> {
    let session = cache.ensure_session(is_input)?;

    let mut peak = 0.0_f32;
    let mut peak_l = 0.0_f32;
    let mut peak_r = 0.0_f32;

    if let Some(ref meter) = session.meter {
        if let Err(err) = meter.GetPeakValue(&mut peak).ok() {
            if strict_meter {
                return Err(winerr(err));
            }
        } else {
            let mut channels = 0_u32;
            if meter.GetMeteringChannelCount(&mut channels).is_ok() && channels >= 2 {
                // Zero-allocation stack buffer for up to 8 channels (7.1 surround)
                let mut stack_buf = [0.0_f32; 8];
                if channels as usize <= stack_buf.len()
                    && meter
                        .GetChannelsPeakValues(channels, stack_buf.as_mut_ptr())
                        .is_ok()
                {
                    peak_l = stack_buf[0];
                    peak_r = stack_buf[1];
                } else {
                    peak_l = peak;
                    peak_r = peak;
                }
            } else {
                peak_l = peak;
                peak_r = peak;
            }
        }
    }

    let mut volume = 0.75_f32;
    let mut muted_int = 0_i32;

    if let Some(ref ep_vol) = session.volume {
        ep_vol
            .GetMasterVolumeLevelScalar(&mut volume)
            .ok()
            .map_err(winerr)?;
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

fn set_master_volume_with(
    cache: &mut AudioWorkerCache,
    is_input: bool,
    level: f32,
) -> Result<AudioTelemetry, AudioError> {
    unsafe {
        let clamped = level.clamp(0.0, 1.0);

        let attempt = |c: &mut AudioWorkerCache| -> Result<(), AudioError> {
            let session = c.ensure_session(is_input)?;
            let ep_vol = session
                .volume
                .as_ref()
                .ok_or_else(|| AudioError::Windows("Volume interface unavailable".into()))?;
            ep_vol
                .SetMasterVolumeLevelScalar(clamped, std::ptr::null())
                .ok()
                .map_err(winerr)?;
            if clamped > 0.005 {
                let _ = ep_vol.SetMute(0, std::ptr::null()).ok();
            }
            Ok(())
        };

        if attempt(cache).is_err() {
            cache.invalidate(is_input);
            attempt(cache)?;
        }
        read_cached_telemetry(cache, is_input, false)
    }
}

fn set_master_mute_with(
    cache: &mut AudioWorkerCache,
    is_input: bool,
    muted: bool,
) -> Result<AudioTelemetry, AudioError> {
    unsafe {
        let attempt = |c: &mut AudioWorkerCache| -> Result<(), AudioError> {
            let session = c.ensure_session(is_input)?;
            let ep_vol = session
                .volume
                .as_ref()
                .ok_or_else(|| AudioError::Windows("Volume interface unavailable".into()))?;
            ep_vol
                .SetMute(if muted { 1 } else { 0 }, std::ptr::null())
                .ok()
                .map_err(winerr)?;
            Ok(())
        };

        if attempt(cache).is_err() {
            cache.invalidate(is_input);
            attempt(cache)?;
        }
        read_cached_telemetry(cache, is_input, false)
    }
}

fn cycle_device_with(
    cache: &mut AudioWorkerCache,
    data_flow: EDataFlow,
    label: &'static str,
) -> Result<AudioDevice, AudioError> {
    let devices = if data_flow == eCapture {
        list_inputs_cached(cache)?
    } else {
        list_outputs_cached(cache)?
    };
    if devices.is_empty() {
        return Err(AudioError::NoDevices(label));
    }

    let current_index = devices
        .iter()
        .position(|device| device.is_default)
        .unwrap_or(0);
    let next_index = (current_index + 1) % devices.len();
    let next = devices[next_index].clone();

    activate_endpoint(cache, &next.id)?;

    Ok(AudioDevice {
        is_default: true,
        ..next
    })
}

/* -------------------------------------------------------------------------- */
/* Event-Driven IMMNotificationClient Watcher (0% Idle CPU, No Polling)       */
/* -------------------------------------------------------------------------- */

struct DebounceSignal {
    pending: Mutex<bool>,
    cvar: Condvar,
}

impl DebounceSignal {
    fn trigger(&self) {
        bump_generation();
        if let Ok(mut pending) = self.pending.lock() {
            *pending = true;
            self.cvar.notify_one();
        }
    }
}

#[implement(IMMNotificationClient)]
struct EndpointNotificationClient {
    signal: Arc<DebounceSignal>,
}

impl IMMNotificationClient_Impl for EndpointNotificationClient_Impl {
    fn OnDeviceStateChanged(
        &self,
        _pwstrdeviceid: &PCWSTR,
        _dwnewstate: DEVICE_STATE,
    ) -> windows_core::Result<()> {
        self.signal.trigger();
        Ok(())
    }

    fn OnDeviceAdded(&self, _pwstrdeviceid: &PCWSTR) -> windows_core::Result<()> {
        self.signal.trigger();
        Ok(())
    }

    fn OnDeviceRemoved(&self, _pwstrdeviceid: &PCWSTR) -> windows_core::Result<()> {
        self.signal.trigger();
        Ok(())
    }

    fn OnDefaultDeviceChanged(
        &self,
        _flow: EDataFlow,
        role: ERole,
        _pwstrdefaultdeviceid: &PCWSTR,
    ) -> windows_core::Result<()> {
        if role == eConsole || role == eMultimedia {
            self.signal.trigger();
        }
        Ok(())
    }

    fn OnPropertyValueChanged(
        &self,
        _pwstrdeviceid: &PCWSTR,
        key: &PROPERTYKEY,
    ) -> windows_core::Result<()> {
        if *key == PKEY_Device_FriendlyName {
            self.signal.trigger();
        }
        Ok(())
    }
}

pub fn subscribe_device_changes<F>(on_change: F)
where
    F: Fn() + Send + Sync + 'static,
{
    let signal = Arc::new(DebounceSignal {
        pending: Mutex::new(false),
        cvar: Condvar::new(),
    });

    // Dedicated COM Notification Registration + Trailing 80ms Coalescer
    std::thread::Builder::new()
        .name("audiocycle-wasapi-events".into())
        .spawn(move || unsafe {
            let _com = ComApartmentGuard::enter(COINIT_MULTITHREADED);
            let Ok(enumerator) =
                CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL)
            else {
                return;
            };

            let client: IMMNotificationClient = EndpointNotificationClient {
                signal: Arc::clone(&signal),
            }
            .into();

            if enumerator
                .RegisterEndpointNotificationCallback(&client)
                .is_err()
            {
                return;
            }

            // Sleep with 0% CPU until WASAPI signals a real hardware/role event,
            // then coalesce bursts (e.g. Console + Multimedia + Communications) over 80ms.
            loop {
                let mut guard = match signal.pending.lock() {
                    Ok(g) => g,
                    Err(_) => break,
                };
                while !*guard {
                    guard = match signal.cvar.wait(guard) {
                        Ok(g) => g,
                        Err(_) => return,
                    };
                }

                // Coalesce trailing burst notifications
                loop {
                    *guard = false;
                    let Ok((next_guard, timeout)) =
                        signal.cvar.wait_timeout(guard, Duration::from_millis(80))
                    else {
                        return;
                    };
                    if timeout.timed_out() && !*next_guard {
                        drop(next_guard);
                        break;
                    }
                    guard = next_guard;
                }

                on_change();
            }
        })
        .ok();
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
    let value = String::from_utf16_lossy(id.as_wide());
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

    let name = String::from_utf16_lossy(value.as_wide());
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
        role: ERole,
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
    unsafe fn GetMeteringChannelCount(&self, channel_count: *mut u32) -> windows::core::HRESULT;
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
    unsafe fn RegisterControlChangeNotify(&self, notify: *const c_void) -> windows::core::HRESULT;
    unsafe fn UnregisterControlChangeNotify(&self, notify: *const c_void)
        -> windows::core::HRESULT;
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
    unsafe fn SetMute(&self, mute: i32, event_context: *const GUID) -> windows::core::HRESULT;
    unsafe fn GetMute(&self, mute: *mut i32) -> windows::core::HRESULT;
}
