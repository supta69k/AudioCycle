import type { Accent, AppSettings, AudioDevice, MonitorBounds, OrbSize } from "../types/audio";

export const POSITION_KEY = "audiocycle.widget-position";
export const SETTINGS_KEY = "audiocycle.settings.v3";
export const SNAP_MARGIN = 12;
export const COMPACT_WINDOW_WIDTH = 236;
export const COMPACT_WINDOW_HEIGHT = 156;
export const PANEL_WINDOW_WIDTH = 360;
export const PANEL_WINDOW_HEIGHT = 540;
export const RING_DOTS = 36;

export const SIZE_MAP: Record<OrbSize, number> = {
  compact: 52,
  normal: 62,
  large: 72,
};

export const ACCENTS: Record<Accent, string> = {
  signal: "#ff4f1f",
  white: "#f2f2f2",
  lime: "#c6ff3d",
  blue: "#4d7cff",
};

export const DEFAULT_SETTINGS: AppSettings = {
  orbShape: "circle",
  orbSize: "normal",
  accent: "signal",
  wheelVolumeControl: true,
  switchTone: true,
  clickAction: "cycle-current",
  rightClickAction: "open-panel",
  snapToEdges: true,
  idleAutoDim: true,
  showTooltip: true,
  showToast: true,
  showQuickControls: true,
  excludedDeviceIds: [],
};

export const FALLBACK_OUTPUTS: AudioDevice[] = [
  { id: "out-1", name: "Headphones (DAC)", is_default: true },
  { id: "out-2", name: "Desktop Speakers", is_default: false },
  { id: "out-3", name: "HDMI Display Audio", is_default: false },
  { id: "out-4", name: "Bluetooth Headset", is_default: false },
];

export const FALLBACK_INPUTS: AudioDevice[] = [
  { id: "in-1", name: "USB Microphone", is_default: true },
  { id: "in-2", name: "Headset Microphone", is_default: false },
];

export const FALLBACK_MONITOR: MonitorBounds = {
  x: 0,
  y: 0,
  width: window.screen.availWidth || 1920,
  height: window.screen.availHeight || 1080,
};
