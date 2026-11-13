# Contributing to AudioCycle

Thank you for considering contributing to **AudioCycle**. Focus stays on low resource overhead, clean Windows CoreAudio integration, and sharp instrument-panel minimalism.

## Prerequisites

- **OS:** Windows 10 (1809+) or Windows 11 with Microsoft Edge WebView2 Runtime
- **Node.js:** v20 or later (`npm`)
- **Rust:** Stable toolchain (`rustup`) with Visual Studio C++ Build Tools (MSVC + Windows SDK)

## Local Setup

```powershell
git clone https://github.com/supta69k/AudioCycle.git
cd AudioCycle
npm install
npm run tauri:dev
```

## Verification Before Opening a PR

Run all checks locally before pushing:

```powershell
npm run typecheck
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

If modifying overlay click-through geometry (`src-tauri/src/overlay.rs` or `src/utils/hitRegions.ts`) or multi-monitor behavior (`src/utils/display.ts`), verify manually with `npm run tauri:build -- --no-bundle` across standard (`100%`) and scaled (`125%` / `150%`) Windows displays.

## Commit Style

This repository uses [Conventional Commits](https://www.conventionalcommits.org/):

- `feat(scope): ...` for new features
- `fix(scope): ...` for bug fixes
- `perf(scope): ...` for performance or stability optimizations
- `docs(scope): ...` for documentation updates
- `chore(scope): ...` for build, CI, or maintenance tasks
