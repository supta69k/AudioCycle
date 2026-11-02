# AudioCycle

**AudioCycle** is an ultra-lightweight, always-on-top Windows audio output & microphone switcher built with **Tauri 2**, **Rust**, and **React**. Inspired by minimal hardware instrument panels, it pairs a dot-matrix floating pod with an event-driven native Windows CoreAudio (WASAPI) backend.

---

## Features

- **Instant 1-Click Cycling** — Click the floating pod (or press `Alt + Shift + C` anywhere) to cycle through active speakers, headphones, DACs, or microphones across Console, Multimedia, and Communications roles simultaneously.
- **Direct Scroll Volume & Middle-Click Mute** — Scroll over the floating pod to adjust system volume (`±4%` per notch) with a 36-dot radial dial, or middle-click to mute/unmute instantly.
- **Instrument-Panel Control Window** (`Alt + Shift + S` or Right-Click):
  - **Dot-Matrix Readout & Dual-Layer Level Meter** — 32-cell meter displaying both hardware volume level and live stereo signal peaks with fast-attack / smooth-release ballistics.
  - **Loop / Skip Per Endpoint** — Exclude unused monitor speakers or virtual cables from 1-click rotation while keeping them selectable on demand.
  - **Clean Customization** — Choose accent color (`Signal`, `White`, `Lime`, `Blue`), pod geometry (`Round`, `Soft`, `Square`), size (`S` / `M` / `L`), click actions, edge-snapping, idle auto-fade, and Windows startup launch.
- **Event-Driven WASAPI Engine (0% Idle Polling)** — Uses native `IMMNotificationClient` callbacks for instant plug/unplug and default-device detection alongside thread-local cached COM sessions (`IAudioMeterInformation` & `IAudioEndpointVolume`).
- **Headless CLI & Stream Deck Support** — Trigger instant switching from scripts, macro pads, or Elgato Stream Deck without spawning duplicate UI instances:
  ```powershell
  AudioCycle.exe --cycle-output
  AudioCycle.exe --cycle-input
  ```

---

## Global Shortcuts

| Action | Shortcut |
| :--- | :--- |
| Cycle active device | `Alt + Shift + C` |
| Show / Hide floating pod | `Alt + Shift + A` |
| Open / Close control panel | `Alt + Shift + S` |

---

## Project Architecture

```text
├── src/                        # React + TypeScript Frontend
│   ├── components/Primitives.tsx  # Memoized UI primitives (DotRing, LevelMeter, Toggle, Segmented)
│   ├── constants/config.ts        # Geometry, storage keys & theme tokens
│   ├── types/audio.ts             # Domain & IPC contracts
│   ├── utils/                     # Multi-monitor docking math & Web Audio switch tones
│   ├── App.tsx                    # State orchestration & Tauri IPC bridge
│   └── styles.css                 # Minimalist instrument-panel design system
└── src-tauri/                  # Rust + Tauri v2 Native Core
    ├── src/audio/                 # Cross-platform facade + Windows WASAPI engine (cached COM + IMMNotificationClient)
    ├── src/commands.rs            # Tauri IPC command handlers
    ├── src/instance.rs            # Named-mutex single instance guard + wake-on-relaunch event
    ├── src/tray.rs                # System tray menu & global shortcut registration
    ├── tauri.conf.json            # Standard desktop configuration
    └── tauri.microsoftstore.conf.json # Offline WebView2 bundle overlay for Microsoft Store
```

---

## Development & Building

```powershell
# Install dependencies
npm install

# Run in development mode
npm run tauri:dev

# Build optimized production binary & installers (.msi / -setup.exe)
npm run tauri:build

# Build offline installer package for Microsoft Store submission
npm run tauri:build:store
```
