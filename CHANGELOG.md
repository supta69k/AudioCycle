# Changelog

All notable changes to **AudioCycle** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Exact geometric hit-region click-through controller (`overlay.rs` + `src/utils/hitRegions.ts`) so surrounding transparent compact window space passes clicks straight through to applications underneath while keeping shadows and animations unclipped.
- Extracted `ControlPanel` UI into `src/components/ControlPanel.tsx` alongside repository CI, templates, and MIT licensing.

### Fixed
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
