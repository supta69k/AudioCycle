export type AudioDevice = {
  id: string;
  name: string;
  is_default: boolean;
};

export type AudioTelemetry = {
  peak: number;
  peak_l: number;
  peak_r: number;
  volume: number;
  muted: boolean;
  active: boolean;
};

export type WidgetPosition = { x: number; y: number };
export type MonitorBounds = { x: number; y: number; width: number; height: number };

export type DeviceKind = "headphones" | "speaker" | "monitor" | "bluetooth" | "default" | "empty";
export type CycleMode = "output" | "input";
export type DockSide = "left" | "right";
export type PanelView = "devices" | "settings";

export type OrbShape = "circle" | "squircle" | "square";
export type OrbSize = "compact" | "normal" | "large";
export type Accent = "signal" | "white" | "lime" | "blue";
export type ClickAction = "cycle-current" | "cycle-output" | "cycle-input" | "open-panel";
export type RightClickAction = "open-panel" | "toggle-mode" | "hide-widget";

export type AppSettings = {
  orbShape: OrbShape;
  orbSize: OrbSize;
  accent: Accent;
  wheelVolumeControl: boolean;
  switchTone: boolean;
  clickAction: ClickAction;
  rightClickAction: RightClickAction;
  snapToEdges: boolean;
  idleAutoDim: boolean;
  showTooltip: boolean;
  showToast: boolean;
  showQuickControls: boolean;
  excludedDeviceIds: string[];
};
