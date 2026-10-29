# AudioCycle

**AudioCycle** is a lightweight, always-on-top floating desktop widget built with **Tauri 2**, **React**, and **Rust** for effortlessly switching between audio output devices (speakers, headphones, monitors, Bluetooth) and microphone inputs on the go.

---

## ✨ Features

- **One-Click Output & Input Cycling** — Instantly rotate through active playback devices or switch to **Microphone Mode** via the side toggle button to cycle audio inputs.
- **AudioCycle Studio Control Panel** — Built-in glassmorphic settings & device studio (`Alt + Shift + S`, right-click orb, or click the gear satellite button) to:
  - Click any **Output** or **Microphone** device to switch immediately, or toggle **Cycle** per device to skip unused endpoints (like monitor speakers) during 1-click rotation.
  - Customize the **Floating Logo** emblem (`Vinyl Disc`, `Device Icon`, `Waveform`, `Neon Core`, or `Custom Text/Emoji`), orb **shape** (`Squircle`, `Circle`, `Soft Box`), **size** (`48px` / `58px` / `68px`), and **color theme** (`Auto Device`, presets, or custom hex color pickers).
  - Configure **App Functions** including Left-Click / Right-Click actions, edge snapping vs. free-floating placement, idle opacity & auto-dim, tooltips, toasts, and Windows startup launch.
- **Floating Glassmorphic Orb** — Compact, frameless, always-on-top widget with a spinning vinyl emblem and real-time audio activity level bars powered by Windows `IAudioMeterInformation`.
- **Smart Edge Docking & Multi-Monitor Support** — Drag anywhere across connected displays; automatically clamps to screen bounds and snaps cleanly to the left or right monitor edge.
- **Live Device Detection & Toast Feedback** — Watches for newly connected or disconnected audio endpoints and shows a subtle toast notification and hover status tooltip.
- **System Tray & Global Shortcut** — Includes a system tray menu (**Hide / Show Widget**, **Launch on Startup**, **Quit**) and a global toggle hotkey (`Alt + Shift + A`).
- **Headless CLI & Stream Deck Integration** — Switch audio outputs or microphone inputs directly from command-line flags or Elgato Stream Deck actions without opening a second instance.
- **Native Windows Core Audio** — Uses `IMMDeviceEnumerator` and `IPolicyConfig` COM interfaces in Rust to switch default endpoints across Console, Multimedia, and Communications roles simultaneously.

---

## 🎮 CLI & Stream Deck Usage

You can trigger device cycling directly from the command line, batch scripts, hotkey utilities, or **Elgato Stream Deck** (Desktop / Mobile):

```powershell
# Cycle active speakers / headphones / audio outputs
AudioCycle.exe --cycle-output

# Cycle active microphones / audio inputs
AudioCycle.exe --cycle-input
```

Launching `AudioCycle.exe` without arguments starts the floating desktop widget (enforcing a single running instance).

---

## 🛠️ Tech Stack

- **Frontend:** React 18, TypeScript, Vite, Tailwind CSS, Lucide Icons
- **Backend / Shell:** Rust, Tauri v2 (`tray-icon`, `autostart`, `global-shortcut`)
- **Platform APIs:** Windows Core Audio (`windows` crate v0.58 — `IMMDeviceEnumerator`, `IPolicyConfig`, `IAudioMeterInformation`)

---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Rust & Cargo](https://rustup.rs/)
- [Tauri v2 Prerequisites](https://v2.tauri.app/start/prerequisites/) (Microsoft C++ Build Tools & WebView2 on Windows)

### Development

Install dependencies and launch the Tauri development build:

```powershell
npm install
npm run tauri:dev
```

To preview the frontend UI in a browser:

```powershell
npm run dev
```

### Production Build

Build the standalone Windows executable and installer bundle:

```powershell
npm run tauri:build
```

> **Note:** Native audio endpoint enumeration and switching are currently implemented for Windows. Non-Windows builds compile cleanly and return an unsupported-platform message.
