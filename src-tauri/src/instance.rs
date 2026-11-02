#[cfg(windows)]
pub fn ensure_single_instance_or_wake() -> bool {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows::Win32::System::Threading::{CreateEventW, CreateMutexW, SetEvent};

    let mutex_name: Vec<u16> = "AudioCycle.SingleInstance\0".encode_utf16().collect();
    let event_name: Vec<u16> = "AudioCycle.WakeInstance\0".encode_utf16().collect();

    unsafe {
        let Ok(mutex) = CreateMutexW(None, false, PCWSTR(mutex_name.as_ptr())) else {
            return true;
        };
        let already_running = GetLastError() == ERROR_ALREADY_EXISTS;
        let _ = mutex;

        if already_running {
            // Wake the running instance so launching the shortcut reveals a hidden widget
            if let Ok(event) = CreateEventW(None, false, false, PCWSTR(event_name.as_ptr())) {
                let _ = SetEvent(event);
            }
            return false;
        }
        true
    }
}

#[cfg(not(windows))]
pub fn ensure_single_instance_or_wake() -> bool {
    true
}

#[cfg(windows)]
pub fn spawn_wake_listener<F>(on_wake: F)
where
    F: Fn() + Send + 'static,
{
    use windows::core::PCWSTR;
    use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject, INFINITE};

    std::thread::Builder::new()
        .name("audiocycle-instance-wake".into())
        .spawn(move || unsafe {
            let event_name: Vec<u16> = "AudioCycle.WakeInstance\0".encode_utf16().collect();
            let Ok(event) = CreateEventW(None, false, false, PCWSTR(event_name.as_ptr())) else {
                return;
            };
            loop {
                // Blocks at 0% CPU until a second process signals the named event
                let res = WaitForSingleObject(event, INFINITE);
                if res.0 != 0 {
                    break;
                }
                on_wake();
            }
        })
        .ok();
}

#[cfg(not(windows))]
pub fn spawn_wake_listener<F>(_on_wake: F)
where
    F: Fn() + Send + 'static,
{
}
