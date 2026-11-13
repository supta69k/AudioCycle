# Changelog

All notable changes to **AudioCycle** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Exact geometric hit-region click-through controller (`overlay.rs` + `src/utils/hitRegions.ts`) so surrounding transparent compact window space passes clicks straight through to applications underneath while keeping shadows and animations unclipped.
- Extracted `ControlPanel` UI into `src/components/ControlPanel.tsx` alongside repository CI, templates, and MIT licensing.

### Fixed
- Eliminated `AppHangB1` (`dwmapi.dll`) UI hangs by keeping `WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_TOPMOST` constant, toggling only `WS_EX_TRANSPARENT` without `SWP_FRAMECHANGED`, using `SWP_ASYNCWINDOWPOS`, and serializing cursor hit-test evaluation through a condvar-woken guard thread.
- Moved all WASAPI COM endpoint/telemetry operations onto a dedicated background STA worker thread (`audiocycle-audio-worker`) with RAII `CoInitializeEx`/`CoUninitialize` guards, cached `IPolicyConfig`, graceful peak-meter fallback, and non-blocking `spawn_blocking` Tauri commands.
- Added frontend IPC backpressure protection (`telemetryInFlight` guard, `HitConfig` JSON deduplication, and hover mouse-move short-circuiting).
- Win32 `HWND_TOPMOST` and `WS_EX_TOOLWINDOW` enforcement on display changes, focus loss, and cursor-ignore transitions so the floating pod reliably renders over active windows.
- Logical DPI scaling and multi-monitor coordinate clamping.
- Isolated pod hover activation cleanly to the orb geometry without invisible box triggers.
- Adaptive telemetry polling (`100ms` panel / `160ms` active / `400ms` idle / `0ms` hidden), rAF-batched dragging, and safer thread-local WASAPI COM initialization.
- Dedicated Volume Mode on single middle-click (`±4%` wheel control only when active) and double middle-click mute/unmute toggle.

## [0.1.0] - Initial Release

### Added
- Minimalist floating audio output & input switcher for Windows powered by Tauri v2, React, TypeScript, and Rust CoreAudio (WASAPI).
- Event-driven `IMMNotificationClient` device notifications with per-device exclusion loop filtering.
- 36-dot radial level ring, live 32-cell stereo VU meter, customizable shapes/sizes/accents, global hotkeys, system tray controls, and headless `--cycle-output` / `--cycle-input` CLI flags.
