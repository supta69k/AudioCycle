import { invoke } from "@tauri-apps/api/core";
import { LogicalPosition, LogicalSize, getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
  AudioWaveform,
  Bluetooth,
  Check,
  ChevronRight,
  CircleDot,
  Disc3,
  Headphones,
  Keyboard,
  Mic,
  MicOff,
  MonitorSpeaker,
  Music,
  Music2,
  Palette,
  Power,
  Radio,
  RefreshCw,
  RotateCcw,
  Settings2,
  Sliders,
  Speaker,
  Volume1,
  Volume2,
  VolumeX,
  Waves,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

type AudioDevice = {
  id: string;
  name: string;
  is_default: boolean;
};

type AudioTelemetry = {
  peak: number;
  peak_l: number;
  peak_r: number;
  volume: number;
  muted: boolean;
  active: boolean;
};

type WidgetPosition = {
  x: number;
  y: number;
};

type MonitorBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type DeviceKind = "headphones" | "speaker" | "monitor" | "bluetooth" | "default" | "empty";
type CycleMode = "output" | "input";
type DockSide = "left" | "right";

export type LogoStyle = "vinyl" | "device" | "waveform" | "minimal" | "custom";
export type OrbShape = "squircle" | "circle" | "rounded";
export type OrbSize = "compact" | "normal" | "large";
export type ThemePreset =
  | "auto"
  | "analog"
  | "vinylGold"
  | "cyber"
  | "sunset"
  | "emerald"
  | "royal"
  | "mono"
  | "custom";
export type SpinBehavior = "activity" | "always" | "off";
export type ClickAction = "cycle-current" | "cycle-output" | "cycle-input" | "open-panel";
export type RightClickAction = "open-panel" | "toggle-mode" | "hide-widget";
type PanelTab = "devices" | "logo" | "behavior";

export type AppSettings = {
  logoStyle: LogoStyle;
  customBadge: string;
  orbShape: OrbShape;
  orbSize: OrbSize;
  theme: ThemePreset;
  customAccentA: string;
  customAccentB: string;
  showEqBars: boolean;
  showPulseWaves: boolean;
  showVolumeRing: boolean;
  wheelVolumeControl: boolean;
  acousticChime: boolean;
  spinBehavior: SpinBehavior;
  clickAction: ClickAction;
  rightClickAction: RightClickAction;
  snapToEdges: boolean;
  idleAutoDim: boolean;
  idleOpacity: number;
  showTooltip: boolean;
  showToast: boolean;
  showQuickControls: boolean;
  excludedDeviceIds: string[];
};

const POSITION_KEY = "audiocycle.widget-position";
const SETTINGS_KEY = "audiocycle.settings.v2";
const SNAP_MARGIN = 12;
const COMPACT_WINDOW_WIDTH = 236;
const COMPACT_WINDOW_HEIGHT = 156;
const PANEL_WINDOW_WIDTH = 392;
const PANEL_WINDOW_HEIGHT = 556;

const SIZE_MAP: Record<OrbSize, number> = {
  compact: 50,
  normal: 60,
  large: 70,
};

const THEME_COLORS: Record<Exclude<ThemePreset, "auto" | "custom">, [string, string]> = {
  analog: ["#f59e0b", "#ef4444"],
  vinylGold: ["#eab308", "#a855f7"],
  cyber: ["#67e8f9", "#a78bfa"],
  sunset: ["#fb7185", "#fbbf24"],
  emerald: ["#34d399", "#2dd4bf"],
  royal: ["#c084fc", "#60a5fa"],
  mono: ["#f8fafc", "#94a3b8"],
};

const DEFAULT_SETTINGS: AppSettings = {
  logoStyle: "vinyl",
  customBadge: "LP",
  orbShape: "squircle",
  orbSize: "normal",
  theme: "analog",
  customAccentA: "#f59e0b",
  customAccentB: "#ef4444",
  showEqBars: true,
  showPulseWaves: true,
  showVolumeRing: true,
  wheelVolumeControl: true,
  acousticChime: true,
  spinBehavior: "activity",
  clickAction: "cycle-current",
  rightClickAction: "open-panel",
  snapToEdges: true,
  idleAutoDim: true,
  idleOpacity: 0.42,
  showTooltip: true,
  showToast: true,
  showQuickControls: true,
  excludedDeviceIds: [],
};

const FALLBACK_OUTPUTS: AudioDevice[] = [
  { id: "out-headphones", name: "Beyerdynamic DT 990 Pro (DAC)", is_default: true },
  { id: "out-speakers", name: "Yamaha HS8 Studio Monitors", is_default: false },
  { id: "out-monitor", name: "LG UltraGear HDMI Audio", is_default: false },
  { id: "out-bt", name: "Sony WH-1000XM5 Bluetooth", is_default: false },
];

const FALLBACK_INPUTS: AudioDevice[] = [
  { id: "in-mic-usb", name: "Shure SM7B + Focusrite Scarlett", is_default: true },
  { id: "in-headset", name: "Wireless Boom Microphone", is_default: false },
];

// Shared Web Audio context for zero-latency studio chimes & test tones
let sharedAudioCtx: AudioContext | null = null;
function getAudioContext(): AudioContext | null {
  try {
    if (!sharedAudioCtx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      sharedAudioCtx = new AudioCtx();
    }
    if (sharedAudioCtx.state === "suspended") {
      void sharedAudioCtx.resume();
    }
    return sharedAudioCtx;
  } catch {
    return null;
  }
}

function playSwitchChime(mode: CycleMode, enabled: boolean) {
  if (!enabled) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  const now = ctx.currentTime;
  const notes = mode === "output" ? [523.25, 659.25, 783.99] : [440, 554.37];
  notes.forEach((freq, idx) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq, now + idx * 0.045);

    gain.gain.setValueAtTime(0.0001, now + idx * 0.045);
    gain.gain.exponentialRampToValueAtTime(0.06, now + idx * 0.045 + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.045 + 0.22);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now + idx * 0.045);
    osc.stop(now + idx * 0.045 + 0.24);
  });
}

function playStudioTestChord(onPeakUpdate?: (l: number, r: number) => void) {
  const ctx = getAudioContext();
  if (!ctx) return;

  const now = ctx.currentTime;
  // Warm Cmaj9 studio electric piano voicing
  const chord = [261.63, 329.63, 392.0, 493.88, 587.33];
  chord.forEach((freq, idx) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;

    osc.type = idx % 2 === 0 ? "sine" : "triangle";
    osc.frequency.setValueAtTime(freq, now + idx * 0.055);

    const start = now + idx * 0.055;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.055 / Math.sqrt(idx + 1), start + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.95);

    if (panner) {
      panner.pan.setValueAtTime((idx - 2) * 0.35, start);
      osc.connect(gain);
      gain.connect(panner);
      panner.connect(ctx.destination);
    } else {
      osc.connect(gain);
      gain.connect(ctx.destination);
    }

    osc.start(start);
    osc.stop(start + 1.0);
  });

  if (onPeakUpdate) {
    let step = 0;
    const timer = window.setInterval(() => {
      step += 1;
      const decay = Math.max(0, 1 - step / 18);
      const l = Math.min(1, decay * (0.68 + Math.sin(step * 0.9) * 0.22));
      const r = Math.min(1, decay * (0.66 + Math.cos(step * 0.85) * 0.24));
      onPeakUpdate(l, r);
      if (step >= 18) {
        window.clearInterval(timer);
        onPeakUpdate(0, 0);
      }
    }, 50);
  }
}

function loadPosition(): WidgetPosition {
  try {
    const saved = localStorage.getItem(POSITION_KEY);
    if (saved) return JSON.parse(saved) as WidgetPosition;
  } catch {
    // Fall back to default coordinates.
  }
  return { x: 18, y: 180 };
}

function loadSettings(): AppSettings {
  try {
    const saved = localStorage.getItem(SETTINGS_KEY) ?? localStorage.getItem("audiocycle.settings.v1");
    if (saved) {
      return { ...DEFAULT_SETTINGS, ...(JSON.parse(saved) as Partial<AppSettings>) };
    }
  } catch {
    // Fall back to defaults.
  }
  return DEFAULT_SETTINGS;
}

const FALLBACK_MONITOR: MonitorBounds = {
  x: 0,
  y: 0,
  width: window.screen.availWidth || 1920,
  height: window.screen.availHeight || 1080,
};

function getNearestMonitor(point: WidgetPosition, monitors: MonitorBounds[], orbPixels = 60): MonitorBounds {
  const candidates = monitors.length ? monitors : [FALLBACK_MONITOR];
  const centerX = point.x + orbPixels / 2;
  const centerY = point.y + orbPixels / 2;

  return candidates.reduce((nearest, monitor) => {
    const nearestX = Math.min(Math.max(centerX, monitor.x), monitor.x + monitor.width);
    const nearestY = Math.min(Math.max(centerY, monitor.y), monitor.y + monitor.height);
    const currentDistance = (centerX - nearestX) ** 2 + (centerY - nearestY) ** 2;

    const nearestMonitorX = Math.min(Math.max(centerX, nearest.x), nearest.x + nearest.width);
    const nearestMonitorY = Math.min(Math.max(centerY, nearest.y), nearest.y + nearest.height);
    const nearestDistance = (centerX - nearestMonitorX) ** 2 + (centerY - nearestMonitorY) ** 2;

    return currentDistance < nearestDistance ? monitor : nearest;
  }, candidates[0]);
}

function clampPosition(
  point: WidgetPosition,
  monitors: MonitorBounds[],
  winWidth = COMPACT_WINDOW_WIDTH,
  winHeight = COMPACT_WINDOW_HEIGHT,
): WidgetPosition {
  const monitor = getNearestMonitor(point, monitors);
  const minX = monitor.x;
  const maxX = monitor.x + monitor.width - winWidth;
  const minY = monitor.y + SNAP_MARGIN;
  const maxY = monitor.y + monitor.height - winHeight - SNAP_MARGIN;

  return {
    x: Math.min(Math.max(point.x, minX), Math.max(minX, maxX)),
    y: Math.min(Math.max(point.y, minY), Math.max(minY, maxY)),
  };
}

function snapToSide(point: WidgetPosition, monitors: MonitorBounds[], snapEnabled: boolean): WidgetPosition {
  const clamped = clampPosition(point, monitors);
  if (!snapEnabled) return clamped;

  const monitor = getNearestMonitor(clamped, monitors);
  const leftX = monitor.x;
  const rightX = monitor.x + monitor.width - COMPACT_WINDOW_WIDTH;
  const centerX = clamped.x + COMPACT_WINDOW_WIDTH / 2;
  const monitorCenterX = monitor.x + monitor.width / 2;

  return {
    ...clamped,
    x: centerX < monitorCenterX ? leftX : rightX,
  };
}

function getDockSide(position: WidgetPosition, monitors: MonitorBounds[], orbPixels: number): DockSide {
  const monitor = getNearestMonitor(position, monitors, orbPixels);
  const monitorCenterX = monitor.x + monitor.width / 2;
  return position.x + orbPixels / 2 < monitorCenterX ? "left" : "right";
}

function getDeviceKind(device?: AudioDevice): DeviceKind {
  if (!device) return "empty";

  const name = device.name.toLowerCase();

  if (name.includes("bluetooth") || name.includes("bt ") || name.includes("xm5") || name.includes("airpods")) {
    return "bluetooth";
  }
  if (
    name.includes("headphone") ||
    name.includes("headset") ||
    name.includes("earbud") ||
    name.includes("dac") ||
    name.includes("dt ")
  ) {
    return "headphones";
  }
  if (
    name.includes("monitor") ||
    name.includes("display") ||
    name.includes("hdmi") ||
    name.includes("nvidia") ||
    name.includes("amd high definition")
  ) {
    return "monitor";
  }
  if (name.includes("speaker") || name.includes("realtek") || name.includes("yamaha")) return "speaker";

  return "default";
}

function getDeviceKindLabel(kind: DeviceKind, mode: CycleMode): string {
  if (mode === "input") return "STUDIO INPUT";
  switch (kind) {
    case "headphones":
      return "HI-FI CANS";
    case "speaker":
      return "MONITORS";
    case "monitor":
      return "HDMI / DISPLAY";
    case "bluetooth":
      return "WIRELESS BT";
    case "empty":
      return "OFFLINE";
    default:
      return "LINE OUT";
  }
}

function formatDb(scalar: number, muted: boolean): string {
  if (muted || scalar <= 0.005) return "-∞ dB";
  const db = 20 * Math.log10(scalar);
  return `${db >= -0.2 ? "0.0" : db.toFixed(1)} dB`;
}

function DeviceIcon({ kind, size = 20 }: { kind: DeviceKind; size?: number }) {
  const iconProps = { size, strokeWidth: 2.15 };

  switch (kind) {
    case "bluetooth":
      return <Bluetooth {...iconProps} />;
    case "headphones":
      return <Headphones {...iconProps} />;
    case "monitor":
      return <MonitorSpeaker {...iconProps} />;
    case "speaker":
      return <Speaker {...iconProps} />;
    case "empty":
      return <Power size={size - 1} strokeWidth={2.15} />;
    default:
      return <Volume2 {...iconProps} />;
  }
}

function FloatingLogoGlyph({
  settings,
  mode,
  kind,
  spinning,
  barsActive,
  peak,
  muted,
}: {
  settings: AppSettings;
  mode: CycleMode;
  kind: DeviceKind;
  spinning: boolean;
  barsActive: boolean;
  peak: number;
  muted: boolean;
}) {
  const iconSize = settings.orbSize === "compact" ? 18 : settings.orbSize === "large" ? 25 : 21;
  const barMultipliers = [0.55, 0.9, 1.25, 0.8, 0.6];

  return (
    <span
      className={`audio-mark ${spinning ? "is-spinning" : ""} ${barsActive ? "is-active" : ""} ${
        muted ? "is-muted" : ""
      }`}
      aria-hidden="true"
    >
      <span className={`audio-disc style-${settings.logoStyle}`}>
        {settings.logoStyle === "vinyl" && (
          <>
            <span className="vinyl-grooves" />
            <span className="vinyl-label">
              <span className="vinyl-spindle" />
            </span>
          </>
        )}
        {settings.logoStyle === "device" &&
          (mode === "input" ? (
            muted ? (
              <MicOff size={iconSize} strokeWidth={2.2} />
            ) : (
              <Mic size={iconSize} strokeWidth={2.2} />
            )
          ) : muted ? (
            <VolumeX size={iconSize} strokeWidth={2.2} />
          ) : (
            <DeviceIcon kind={kind} size={iconSize} />
          ))}
        {settings.logoStyle === "waveform" && <AudioWaveform size={iconSize} strokeWidth={2.2} />}
        {settings.logoStyle === "minimal" && <CircleDot size={iconSize} strokeWidth={2.2} />}
        {settings.logoStyle === "custom" && (
          <span className="custom-badge-text">{(settings.customBadge || "LP").slice(0, 3)}</span>
        )}
      </span>

      {settings.logoStyle === "vinyl" && (
        <span className={`vinyl-tonearm ${barsActive || spinning ? "engaged" : ""}`} />
      )}

      {settings.showEqBars && (
        <span className="audio-bars">
          {barMultipliers.map((mult, idx) => {
            const dynamicHeight = barsActive
              ? Math.max(4, Math.min(14, Math.round(4 + peak * 11 * mult)))
              : [5, 8, 11, 7, 4][idx];
            return <i key={idx} style={{ height: `${dynamicHeight}px` }} />;
          })}
        </span>
      )}
    </span>
  );
}

function StereoVuMeterBridge({
  peakL,
  peakR,
  muted,
  active,
}: {
  peakL: number;
  peakR: number;
  muted: boolean;
  active: boolean;
}) {
  const segments = 16;
  const effL = muted ? 0 : peakL;
  const effR = muted ? 0 : peakR;

  const renderRow = (label: string, level: number) => {
    const litCount = Math.round(Math.pow(level, 0.65) * segments);
    return (
      <div className="vu-channel-row">
        <span className="vu-ch-label">{label}</span>
        <div className="vu-led-strip">
          {Array.from({ length: segments }).map((_, i) => {
            const isLit = active && i < litCount;
            const zone = i >= 14 ? "clip" : i >= 10 ? "warn" : "nominal";
            return <span key={i} className={`vu-led zone-${zone} ${isLit ? "lit" : ""}`} />;
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="vu-bridge" aria-label="Stereo VU Level Meter">
      {renderRow("L", effL)}
      {renderRow("R", effR)}
      <div className="vu-scale-row">
        <span>-36</span>
        <span>-18</span>
        <span>-12</span>
        <span>-6</span>
        <span>-3</span>
        <span className="vu-clip-tag">CLIP</span>
      </div>
    </div>
  );
}

export default function App() {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [inputDevices, setInputDevices] = useState<AudioDevice[]>([]);
  const [mode, setMode] = useState<CycleMode>("output");
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [position, setPosition] = useState<WidgetPosition>(() => loadPosition());
  const [monitors, setMonitors] = useState<MonitorBounds[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isHidden, setIsHidden] = useState(false);
  const [isIdle, setIsIdle] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [telemetry, setTelemetry] = useState<AudioTelemetry>({
    peak: 0,
    peak_l: 0,
    peak_r: 0,
    volume: 0.78,
    muted: false,
    active: false,
  });
  const [synthPeaks, setSynthPeaks] = useState<{ l: number; r: number }>({ l: 0, r: 0 });
  const [toast, setToast] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>("devices");
  const [autostart, setAutostart] = useState(false);

  const dragOffset = useRef({ x: 0, y: 0 });
  const dragStarted = useRef(false);
  const savedOrbPosition = useRef<WidgetPosition | null>(null);
  const modeRef = useRef<CycleMode>(mode);
  modeRef.current = mode;

  const appWindow = useMemo(() => {
    try {
      return getCurrentWindow();
    } catch {
      return null;
    }
  }, []);

  const orbPixels = SIZE_MAP[settings.orbSize];
  const visibleDevices = mode === "output" ? devices : inputDevices;
  const activeDevice = visibleDevices.find((device) => device.is_default) ?? visibleDevices[0];
  const activeKind = getDeviceKind(activeDevice);
  const dockSide = getDockSide(position, monitors, orbPixels);

  const effectivePeakL = Math.max(telemetry.peak_l, synthPeaks.l);
  const effectivePeakR = Math.max(telemetry.peak_r, synthPeaks.r);
  const effectivePeak = Math.max(telemetry.peak, effectivePeakL, effectivePeakR);
  const isAudioPresent =
    Boolean(activeDevice) && (telemetry.active || effectivePeak > 0.015) && !telemetry.muted && !isHidden;

  const shouldSpin =
    settings.spinBehavior === "always" || (settings.spinBehavior === "activity" && isAudioPresent);

  function showNotification(message: string) {
    if (settings.showToast) {
      setToast(message);
    }
  }

  function updateSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setSettings((current) => {
      const next = { ...current, [key]: value };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      return next;
    });
  }

  async function refreshDevices() {
    try {
      const [nextOutputs, nextInputs] = await Promise.all([
        invoke<AudioDevice[]>("list_audio_outputs"),
        invoke<AudioDevice[]>("list_audio_inputs"),
      ]);
      setDevices(nextOutputs);
      setInputDevices(nextInputs);
    } catch {
      setDevices((current) => (current.length ? current : FALLBACK_OUTPUTS));
      setInputDevices((current) => (current.length ? current : FALLBACK_INPUTS));
    }
  }

  async function refreshTelemetry(targetMode = modeRef.current) {
    try {
      const next = await invoke<AudioTelemetry>("get_audio_telemetry", { mode: targetMode });
      setTelemetry(next);
    } catch {
      // Browser preview fallback: keep smooth interactive state
    }
  }

  async function handleVolumeChange(newLevel: number) {
    const clamped = Math.min(1, Math.max(0, newLevel));
    setTelemetry((prev) => ({ ...prev, volume: clamped, muted: clamped <= 0.005 ? prev.muted : false }));
    try {
      const updated = await invoke<AudioTelemetry>("set_device_volume", {
        mode,
        level: clamped,
      });
      setTelemetry(updated);
    } catch {
      // Browser preview fallback already updated local state
    }
  }

  async function handleToggleMute() {
    const nextMuted = !telemetry.muted;
    setTelemetry((prev) => ({ ...prev, muted: nextMuted }));
    showNotification(nextMuted ? "Master Muted" : `Unmuted (${Math.round(telemetry.volume * 100)}%)`);
    try {
      const updated = await invoke<AudioTelemetry>("set_device_mute", {
        mode,
        muted: nextMuted,
      });
      setTelemetry(updated);
    } catch {
      // Browser preview fallback
    }
  }

  async function refreshMonitors() {
    try {
      const nextMonitors = await invoke<MonitorBounds[]>("list_monitors");
      setMonitors(nextMonitors);
    } catch {
      setMonitors([FALLBACK_MONITOR]);
    }
  }

  async function refreshAutostart() {
    try {
      const enabled = await invoke<boolean>("get_autostart");
      setAutostart(enabled);
    } catch {
      // Ignore in browser preview
    }
  }

  async function toggleAutostart() {
    try {
      const next = await invoke<boolean>("set_autostart", { enabled: !autostart });
      setAutostart(next);
      showNotification(next ? "Launch on startup enabled" : "Launch on startup disabled");
    } catch {
      setAutostart((prev) => !prev);
      showNotification(!autostart ? "Launch on startup enabled" : "Launch on startup disabled");
    }
  }

  async function applyWindowDimensions(open: boolean) {
    const targetWidth = open ? PANEL_WINDOW_WIDTH : COMPACT_WINDOW_WIDTH;
    const targetHeight = open ? PANEL_WINDOW_HEIGHT : COMPACT_WINDOW_HEIGHT;

    try {
      await invoke("set_window_size", { width: targetWidth, height: targetHeight });
    } catch {
      try {
        await appWindow?.setSize(new LogicalSize(targetWidth, targetHeight));
      } catch {
        // Ignore in browser preview
      }
    }

    if (open) {
      savedOrbPosition.current = position;
      const clampedForPanel = clampPosition(position, monitors, PANEL_WINDOW_WIDTH, PANEL_WINDOW_HEIGHT);
      if (clampedForPanel.x !== position.x || clampedForPanel.y !== position.y) {
        setPosition(clampedForPanel);
      }
    } else if (savedOrbPosition.current) {
      const restored = snapToSide(savedOrbPosition.current, monitors, settings.snapToEdges);
      savedOrbPosition.current = null;
      setPosition(restored);
    }
  }

  function toggleControlPanel(forceState?: boolean) {
    setPanelOpen((current) => {
      const next = forceState ?? !current;
      void applyWindowDimensions(next);
      return next;
    });
  }

  useEffect(() => {
    void refreshDevices();
    void refreshMonitors();
    void refreshAutostart();
    void refreshTelemetry();

    // Faster telemetry cadence when Studio Console is open for crisp VU metering
    const telemetryInterval = window.setInterval(
      () => {
        void refreshTelemetry();
      },
      panelOpen ? 140 : 300,
    );

    const monitorPoll = window.setInterval(refreshMonitors, 12000);
    const unlisteners = [
      listen("audio-devices-changed", () => {
        void refreshDevices();
        void refreshTelemetry();
      }),
      listen("toggle-widget", () => setIsHidden((current) => !current)),
      listen("cycle-active-shortcut", () => {
        void cycleTargetMode(modeRef.current);
      }),
      listen("open-settings", () => {
        setIsHidden(false);
        toggleControlPanel(true);
      }),
    ];

    return () => {
      window.clearInterval(telemetryInterval);
      window.clearInterval(monitorPoll);
      unlisteners.forEach((promise) => {
        promise.then((unlisten) => unlisten()).catch(() => undefined);
      });
    };
  }, [panelOpen]);

  useEffect(() => {
    void refreshTelemetry(mode);
  }, [mode]);

  useEffect(() => {
    if (!settings.idleAutoDim || panelOpen || switching || isDragging || toast) {
      setIsIdle(false);
      return;
    }

    const timeout = window.setTimeout(() => setIsIdle(true), 2600);
    return () => window.clearTimeout(timeout);
  }, [settings.idleAutoDim, panelOpen, isDragging, switching, toast, activeDevice?.id, mode]);

  useEffect(() => {
    localStorage.setItem(POSITION_KEY, JSON.stringify(position));
    appWindow?.setPosition(new LogicalPosition(position.x, position.y)).catch(() => undefined);
  }, [appWindow, position]);

  useEffect(() => {
    if (!panelOpen) {
      setPosition((current) => snapToSide(current, monitors, settings.snapToEdges));
    }
  }, [monitors, settings.snapToEdges]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 1800);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.altKey && event.shiftKey && event.code === "KeyA") {
        setIsHidden((current) => !current);
      } else if (event.altKey && event.shiftKey && event.code === "KeyS") {
        toggleControlPanel();
      } else if (event.altKey && event.shiftKey && event.code === "KeyC") {
        void cycleTargetMode(modeRef.current);
      } else if (event.key === "Escape" && panelOpen) {
        toggleControlPanel(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [panelOpen]);

  function toggleMode() {
    setMode((current) => {
      const next = current === "output" ? "input" : "output";
      playSwitchChime(next, settings.acousticChime);
      showNotification(next === "input" ? "Studio Mic Deck" : "Master Output Deck");
      return next;
    });
  }

  async function selectSpecificDevice(targetMode: CycleMode, deviceId: string) {
    setSwitching(true);
    try {
      const command = targetMode === "output" ? "set_audio_output" : "set_audio_input";
      const updated = await invoke<AudioDevice>(command, { id: deviceId });
      const applySelection = (list: AudioDevice[]) =>
        list.map((d) => ({ ...d, is_default: d.id === updated.id }));

      if (targetMode === "output") {
        setDevices(applySelection);
      } else {
        setInputDevices(applySelection);
      }
      playSwitchChime(targetMode, settings.acousticChime);
      showNotification(updated.name);
      void refreshTelemetry(targetMode);
    } catch {
      const applyLocal = (list: AudioDevice[]) =>
        list.map((d) => ({ ...d, is_default: d.id === deviceId }));
      const source = targetMode === "output" ? devices : inputDevices;
      const chosen = source.find((d) => d.id === deviceId);
      if (targetMode === "output") {
        setDevices(applyLocal);
      } else {
        setInputDevices(applyLocal);
      }
      playSwitchChime(targetMode, settings.acousticChime);
      if (chosen) showNotification(chosen.name);
    } finally {
      window.setTimeout(() => setSwitching(false), 220);
    }
  }

  async function cycleTargetMode(targetMode: CycleMode) {
    if (switching) return;
    const pool = targetMode === "output" ? devices : inputDevices;
    const enabledPool = pool.filter((d) => !settings.excludedDeviceIds.includes(d.id));
    const effectivePool = enabledPool.length > 0 ? enabledPool : pool;

    if (effectivePool.length > 0 && settings.excludedDeviceIds.length > 0) {
      const currentIndex = effectivePool.findIndex((d) => d.is_default);
      const nextDevice = effectivePool[(currentIndex + 1) % effectivePool.length];
      await selectSpecificDevice(targetMode, nextDevice.id);
      return;
    }

    setSwitching(true);
    try {
      const nextDevice = await invoke<AudioDevice>(
        targetMode === "output" ? "cycle_audio_output" : "cycle_audio_input",
      );
      const updateDevices = (current: AudioDevice[]) =>
        current.map((device) => ({
          ...device,
          is_default: device.id === nextDevice.id,
        }));

      if (targetMode === "output") {
        setDevices(updateDevices);
      } else {
        setInputDevices(updateDevices);
      }
      playSwitchChime(targetMode, settings.acousticChime);
      showNotification(nextDevice.name);
      void refreshTelemetry(targetMode);
    } catch {
      if (effectivePool.length > 0) {
        const currentIndex = effectivePool.findIndex((d) => d.is_default);
        const nextDevice = effectivePool[(currentIndex + 1) % effectivePool.length];
        await selectSpecificDevice(targetMode, nextDevice.id);
      }
    } finally {
      window.setTimeout(() => setSwitching(false), 220);
    }
  }

  async function handlePrimaryOrbClick() {
    if (dragStarted.current || switching) return;

    switch (settings.clickAction) {
      case "cycle-current":
        await cycleTargetMode(mode);
        break;
      case "cycle-output":
        setMode("output");
        await cycleTargetMode("output");
        break;
      case "cycle-input":
        setMode("input");
        await cycleTargetMode("input");
        break;
      case "open-panel":
        toggleControlPanel();
        break;
    }
  }

  function handleOrbWheel(event: React.WheelEvent) {
    if (!settings.wheelVolumeControl) return;
    event.preventDefault();
    const step = event.deltaY < 0 ? 0.04 : -0.04;
    const nextVol = Math.min(1, Math.max(0, telemetry.volume + step));
    void handleVolumeChange(nextVol);
    showNotification(`${mode === "output" ? "Master" : "Mic Gain"} ${Math.round(nextVol * 100)}%`);
  }

  function handleOrbAuxClick(event: React.MouseEvent) {
    if (event.button === 1) {
      event.preventDefault();
      void handleToggleMute();
    }
  }

  function handleOrbContextMenu(event: React.MouseEvent) {
    event.preventDefault();
    if (settings.rightClickAction === "open-panel") {
      toggleControlPanel();
    } else if (settings.rightClickAction === "toggle-mode") {
      toggleMode();
    } else if (settings.rightClickAction === "hide-widget") {
      setIsHidden(true);
    }
  }

  function toggleDeviceExclusion(deviceId: string) {
    const exists = settings.excludedDeviceIds.includes(deviceId);
    const next = exists
      ? settings.excludedDeviceIds.filter((id) => id !== deviceId)
      : [...settings.excludedDeviceIds, deviceId];
    updateSetting("excludedDeviceIds", next);
  }

  function startDrag(event: React.PointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    if (
      event.currentTarget.tagName !== "BUTTON" &&
      (event.target as HTMLElement).closest("button, input, select, a")
    ) {
      return;
    }
    dragStarted.current = false;
    dragOffset.current = {
      x: event.screenX - position.x,
      y: event.screenY - position.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDragging(true);
  }

  function moveDrag(event: React.PointerEvent<HTMLElement>) {
    if (!isDragging) return;

    const winW = panelOpen ? PANEL_WINDOW_WIDTH : COMPACT_WINDOW_WIDTH;
    const winH = panelOpen ? PANEL_WINDOW_HEIGHT : COMPACT_WINDOW_HEIGHT;
    const next = clampPosition(
      {
        x: event.screenX - dragOffset.current.x,
        y: event.screenY - dragOffset.current.y,
      },
      monitors,
      winW,
      winH,
    );

    if (Math.abs(next.x - position.x) > 2 || Math.abs(next.y - position.y) > 2) {
      dragStarted.current = true;
    }
    setPosition(next);
  }

  function endDrag(event: React.PointerEvent<HTMLElement>) {
    if (!isDragging) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setIsDragging(false);
    if (!panelOpen) {
      setPosition((current) => snapToSide(current, monitors, settings.snapToEdges));
    }
    window.setTimeout(() => {
      dragStarted.current = false;
    }, 0);
  }

  function getThemeCssVars(): React.CSSProperties {
    const vars: Record<string, string> = {
      "--orb-size": `${orbPixels}px`,
      "--idle-opacity": String(settings.idleOpacity),
      "--vol-pct": `${Math.round((telemetry.muted ? 0 : telemetry.volume) * 100)}%`,
      "--peak-scale": String(1 + effectivePeak * 0.25),
    };

    if (settings.theme === "custom") {
      vars["--accent-a"] = settings.customAccentA;
      vars["--accent-b"] = settings.customAccentB;
    } else if (settings.theme !== "auto") {
      const [a, b] = THEME_COLORS[settings.theme];
      vars["--accent-a"] = a;
      vars["--accent-b"] = b;
    }

    return vars as React.CSSProperties;
  }

  if (isHidden) {
    return (
      <button className="restore-button" onClick={() => setIsHidden(false)} aria-label="Show AudioCycle">
        <Disc3 size={18} />
      </button>
    );
  }

  if (panelOpen) {
    const volumePct = Math.round(telemetry.volume * 100);

    return (
      <section className="control-panel" style={getThemeCssVars()}>
        {/* Rack Screws Aesthetic */}
        <span className="rack-screw top-left" aria-hidden="true" />
        <span className="rack-screw top-right" aria-hidden="true" />

        <header
          className="panel-header"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div className="panel-brand">
            <div
              className={`panel-mini-orb shape-${settings.orbShape} mode-${mode} kind-${activeKind} ${
                settings.theme !== "auto" ? "custom-theme" : ""
              }`}
            >
              <FloatingLogoGlyph
                settings={{ ...settings, orbSize: "compact" }}
                mode={mode}
                kind={activeKind}
                spinning={shouldSpin}
                barsActive={isAudioPresent}
                peak={effectivePeak}
                muted={telemetry.muted}
              />
            </div>
            <div className="panel-brand-meta">
              <div className="panel-title-row">
                <h1 className="panel-title">AUDIOCYCLE</h1>
                <span className={`on-air-badge ${isAudioPresent ? "live" : ""}`}>
                  <i />
                  {isAudioPresent ? "ON AIR" : "STANDBY"}
                </span>
              </div>
              <p className="panel-subtitle">
                {activeDevice?.name ?? "No active endpoint"}
              </p>
            </div>
          </div>

          <div className="panel-header-actions">
            <button
              type="button"
              className="studio-chime-btn"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                playStudioTestChord((l, r) => setSynthPeaks({ l, r }));
                showNotification("Playing Studio Test Chord ♪");
              }}
              title="Play Acoustic Test Chord on active output"
            >
              <Music size={12} />
              <span>Test</span>
            </button>

            <button
              type="button"
              className="panel-close-btn"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                toggleControlPanel(false);
              }}
              aria-label="Close Studio Console"
              title="Close Console (Esc)"
            >
              <X size={14} />
            </button>
          </div>
        </header>

        {/* STUDIO MASTER BRIDGE: VU Meters + Hardware Fader */}
        <div className="master-bridge">
          <div className="master-bridge-top">
            <StereoVuMeterBridge
              peakL={effectivePeakL}
              peakR={effectivePeakR}
              muted={telemetry.muted}
              active={isAudioPresent}
            />
            <div className="master-readout-box">
              <span className="readout-label">{mode === "output" ? "MASTER OUT" : "MIC GAIN"}</span>
              <span className={`readout-db ${telemetry.muted ? "is-muted" : ""}`}>
                {formatDb(telemetry.volume, telemetry.muted)}
              </span>
              <span className="readout-pct">{telemetry.muted ? "MUTED" : `${volumePct}%`}</span>
            </div>
          </div>

          <div className="master-fader-row">
            <button
              type="button"
              className={`mute-pad-btn ${telemetry.muted ? "active" : ""}`}
              onClick={handleToggleMute}
              title={telemetry.muted ? "Unmute endpoint" : "Mute endpoint"}
            >
              {telemetry.muted ? <VolumeX size={14} /> : telemetry.volume < 0.4 ? <Volume1 size={14} /> : <Volume2 size={14} />}
              <span>{telemetry.muted ? "MUTED" : "MUTE"}</span>
            </button>

            <div className="fader-track-wrap">
              <input
                type="range"
                className="studio-fader"
                min={0}
                max={1}
                step={0.01}
                value={telemetry.muted ? 0 : telemetry.volume}
                onChange={(e) => void handleVolumeChange(parseFloat(e.target.value))}
                aria-label="Master Volume Fader"
              />
            </div>

            <button
              type="button"
              className="cycle-pad-btn"
              onClick={() => void cycleTargetMode(mode)}
              title="Cycle to next enabled device"
            >
              <RefreshCw size={12} className={switching ? "spin-once" : ""} />
              <span>CYCLE</span>
            </button>
          </div>
        </div>

        <nav className="panel-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={panelTab === "devices"}
            className={`panel-tab ${panelTab === "devices" ? "active" : ""}`}
            onClick={() => setPanelTab("devices")}
          >
            <Radio size={13} />
            <span>Patchbay</span>
          </button>
          <button
            role="tab"
            aria-selected={panelTab === "logo"}
            className={`panel-tab ${panelTab === "logo" ? "active" : ""}`}
            onClick={() => setPanelTab("logo")}
          >
            <Disc3 size={13} />
            <span>Turntable UI</span>
          </button>
          <button
            role="tab"
            aria-selected={panelTab === "behavior"}
            className={`panel-tab ${panelTab === "behavior" ? "active" : ""}`}
            onClick={() => setPanelTab("behavior")}
          >
            <Sliders size={13} />
            <span>Console</span>
          </button>
        </nav>

        <div className="panel-body">
          {panelTab === "devices" && (
            <div className="tab-pane">
              <div className="segment-bar">
                <button
                  className={`segment-btn ${mode === "output" ? "active" : ""}`}
                  onClick={() => setMode("output")}
                >
                  <Speaker size={13} />
                  <span>Monitors & Cans ({devices.length})</span>
                </button>
                <button
                  className={`segment-btn ${mode === "input" ? "active" : ""}`}
                  onClick={() => setMode("input")}
                >
                  <Mic size={13} />
                  <span>Mic Inputs ({inputDevices.length})</span>
                </button>
                <button
                  className="icon-action-btn"
                  onClick={() => void refreshDevices()}
                  title="Rescan Windows CoreAudio bus"
                  aria-label="Refresh audio devices"
                >
                  <RefreshCw size={13} />
                </button>
              </div>

              <div className="device-list">
                {visibleDevices.map((device, idx) => {
                  const excluded = settings.excludedDeviceIds.includes(device.id);
                  const kind = getDeviceKind(device);
                  const chLabel = `CH 0${idx + 1}`;
                  return (
                    <div
                      key={device.id}
                      className={`device-card ${device.is_default ? "is-default" : ""} ${
                        excluded ? "is-excluded" : ""
                      }`}
                    >
                      <button
                        className="device-select-btn"
                        onClick={() => void selectSpecificDevice(mode, device.id)}
                        title={`Route audio to ${device.name}`}
                      >
                        <span className="device-card-icon">
                          {mode === "input" ? <Mic size={16} /> : <DeviceIcon kind={kind} size={16} />}
                        </span>
                        <span className="device-card-info">
                          <span className="device-card-top">
                            <span className="ch-tag">{chLabel}</span>
                            <span className="kind-tag">{getDeviceKindLabel(kind, mode)}</span>
                            {device.is_default && <span className="live-dot-badge">ROUTED</span>}
                          </span>
                          <span className="device-card-name">{device.name}</span>
                        </span>
                      </button>

                      <button
                        className={`cycle-pill ${!excluded ? "included" : ""}`}
                        onClick={() => toggleDeviceExclusion(device.id)}
                        title={
                          excluded
                            ? "Bypassed in 1-click rotation (click to include)"
                            : "In 1-click rotation loop (click to bypass)"
                        }
                      >
                        {!excluded && <Check size={10} />}
                        <span>{excluded ? "BYPASS" : "LOOP"}</span>
                      </button>
                    </div>
                  );
                })}
                {visibleDevices.length === 0 && (
                  <div className="empty-state">No active {mode} channels detected on bus.</div>
                )}
              </div>
            </div>
          )}

          {panelTab === "logo" && (
            <div className="tab-pane">
              <div className="field-group">
                <label className="field-label">Turntable / Emblem Style</label>
                <div className="choice-grid cols-3">
                  {(
                    [
                      { id: "vinyl", label: "Vinyl LP + Arm" },
                      { id: "device", label: "Studio Gear" },
                      { id: "waveform", label: "Oscilloscope" },
                      { id: "minimal", label: "Tube Core" },
                      { id: "custom", label: "Custom Label" },
                    ] as const
                  ).map((item) => (
                    <button
                      key={item.id}
                      className={`choice-chip ${settings.logoStyle === item.id ? "active" : ""}`}
                      onClick={() => updateSetting("logoStyle", item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>

              {settings.logoStyle === "custom" && (
                <div className="field-row">
                  <span className="field-label">Record Label Text (1–3 chars)</span>
                  <input
                    type="text"
                    maxLength={3}
                    value={settings.customBadge}
                    onChange={(e) => updateSetting("customBadge", e.target.value)}
                    className="badge-input"
                    placeholder="LP"
                  />
                </div>
              )}

              <div className="field-group">
                <label className="field-label">Studio Lighting Theme</label>
                <div className="choice-grid cols-3">
                  {(
                    [
                      { id: "analog", label: "Analog Tube" },
                      { id: "vinylGold", label: "Vinyl Gold" },
                      { id: "auto", label: "Auto Signal" },
                      { id: "emerald", label: "SSL Emerald" },
                      { id: "cyber", label: "Synth Cyan" },
                      { id: "sunset", label: "Warm Tape" },
                      { id: "royal", label: "Velvet Club" },
                      { id: "mono", label: "Monochrome" },
                      { id: "custom", label: "Custom Duo" },
                    ] as const
                  ).map((item) => (
                    <button
                      key={item.id}
                      className={`choice-chip ${settings.theme === item.id ? "active" : ""}`}
                      onClick={() => updateSetting("theme", item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>

                {settings.theme === "custom" && (
                  <div className="color-pickers-row">
                    <label className="color-picker-item">
                      <span>Primary Tone</span>
                      <input
                        type="color"
                        value={settings.customAccentA}
                        onChange={(e) => updateSetting("customAccentA", e.target.value)}
                      />
                    </label>
                    <label className="color-picker-item">
                      <span>Harmonic Accent</span>
                      <input
                        type="color"
                        value={settings.customAccentB}
                        onChange={(e) => updateSetting("customAccentB", e.target.value)}
                      />
                    </label>
                  </div>
                )}
              </div>

              <div className="field-group">
                <label className="field-label">Floating Pod Geometry & Size</label>
                <div className="choice-grid cols-3">
                  {(
                    [
                      { id: "squircle", label: "MPC Pad" },
                      { id: "circle", label: "Turntable" },
                      { id: "rounded", label: "Rack Unit" },
                    ] as const
                  ).map((item) => (
                    <button
                      key={item.id}
                      className={`choice-chip ${settings.orbShape === item.id ? "active" : ""}`}
                      onClick={() => updateSetting("orbShape", item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <div className="choice-grid cols-3 mt-1">
                  {(
                    [
                      { id: "compact", label: "50px Mini" },
                      { id: "normal", label: "60px Studio" },
                      { id: "large", label: "70px Master" },
                    ] as const
                  ).map((item) => (
                    <button
                      key={item.id}
                      className={`choice-chip ${settings.orbSize === item.id ? "active" : ""}`}
                      onClick={() => updateSetting("orbSize", item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field-group">
                <label className="field-label">Platter Motor & Visual Telemetry</label>
                <div className="choice-grid cols-3">
                  {(
                    [
                      { id: "activity", label: "Spin on Signal" },
                      { id: "always", label: "33⅓ RPM Always" },
                      { id: "off", label: "Static Deck" },
                    ] as const
                  ).map((item) => (
                    <button
                      key={item.id}
                      className={`choice-chip ${settings.spinBehavior === item.id ? "active" : ""}`}
                      onClick={() => updateSetting("spinBehavior", item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>

                <div className="toggle-list mt-1">
                  <label className="toggle-row">
                    <span>Live VU Spectrum Bars on Pod</span>
                    <input
                      type="checkbox"
                      checked={settings.showEqBars}
                      onChange={(e) => updateSetting("showEqBars", e.target.checked)}
                    />
                  </label>
                  <label className="toggle-row">
                    <span>Radial Volume & Peak Halo Ring</span>
                    <input
                      type="checkbox"
                      checked={settings.showVolumeRing}
                      onChange={(e) => updateSetting("showVolumeRing", e.target.checked)}
                    />
                  </label>
                  <label className="toggle-row">
                    <span>Acoustic Sub-Bass Pulse Waves</span>
                    <input
                      type="checkbox"
                      checked={settings.showPulseWaves}
                      onChange={(e) => updateSetting("showPulseWaves", e.target.checked)}
                    />
                  </label>
                </div>
              </div>
            </div>
          )}

          {panelTab === "behavior" && (
            <div className="tab-pane">
              <div className="hotkey-banner">
                <Keyboard size={14} />
                <div className="hotkey-list">
                  <span>
                    <kbd>Alt+Shift+C</kbd> Cycle
                  </span>
                  <span>
                    <kbd>Alt+Shift+A</kbd> Hide
                  </span>
                  <span>
                    <kbd>Scroll</kbd> Vol
                  </span>
                </div>
              </div>

              <div className="field-group">
                <label className="field-label">Primary Left-Click Action</label>
                <select
                  className="panel-select"
                  value={settings.clickAction}
                  onChange={(e) => updateSetting("clickAction", e.target.value as ClickAction)}
                >
                  <option value="cycle-current">Cycle Active Bus (Outputs or Mics)</option>
                  <option value="cycle-output">Always Cycle Master Outputs</option>
                  <option value="cycle-input">Always Cycle Microphones</option>
                  <option value="open-panel">Open Studio Console</option>
                </select>
              </div>

              <div className="field-group">
                <label className="field-label">Right-Click Action</label>
                <select
                  className="panel-select"
                  value={settings.rightClickAction}
                  onChange={(e) => updateSetting("rightClickAction", e.target.value as RightClickAction)}
                >
                  <option value="open-panel">Open Studio Console</option>
                  <option value="toggle-mode">Flip Output / Microphone Deck</option>
                  <option value="hide-widget">Minimize to System Tray</option>
                </select>
              </div>

              <div className="toggle-list">
                <label className="toggle-row">
                  <span>Acoustic Harmonic Chime on Switch</span>
                  <input
                    type="checkbox"
                    checked={settings.acousticChime}
                    onChange={(e) => updateSetting("acousticChime", e.target.checked)}
                  />
                </label>

                <label className="toggle-row">
                  <span>Mouse-Wheel Volume Fader on Floating Pod</span>
                  <input
                    type="checkbox"
                    checked={settings.wheelVolumeControl}
                    onChange={(e) => updateSetting("wheelVolumeControl", e.target.checked)}
                  />
                </label>

                <label className="toggle-row">
                  <span>Magnetic Screen-Edge Dock Snap</span>
                  <input
                    type="checkbox"
                    checked={settings.snapToEdges}
                    onChange={(e) => updateSetting("snapToEdges", e.target.checked)}
                  />
                </label>

                <label className="toggle-row">
                  <span>Show Side Satellite Controls</span>
                  <input
                    type="checkbox"
                    checked={settings.showQuickControls}
                    onChange={(e) => updateSetting("showQuickControls", e.target.checked)}
                  />
                </label>

                <label className="toggle-row">
                  <span>Idle Auto-Dim & Edge Tuck</span>
                  <input
                    type="checkbox"
                    checked={settings.idleAutoDim}
                    onChange={(e) => updateSetting("idleAutoDim", e.target.checked)}
                  />
                </label>

                {settings.idleAutoDim && (
                  <div className="slider-row">
                    <span>Idle Opacity ({Math.round(settings.idleOpacity * 100)}%)</span>
                    <input
                      type="range"
                      min={0.2}
                      max={0.95}
                      step={0.05}
                      value={settings.idleOpacity}
                      onChange={(e) => updateSetting("idleOpacity", parseFloat(e.target.value))}
                    />
                  </div>
                )}

                <label className="toggle-row">
                  <span>Launch AudioCycle on Windows Boot</span>
                  <input type="checkbox" checked={autostart} onChange={toggleAutostart} />
                </label>
              </div>

              <button
                className="reset-btn"
                onClick={() => {
                  setSettings(DEFAULT_SETTINGS);
                  localStorage.setItem(SETTINGS_KEY, JSON.stringify(DEFAULT_SETTINGS));
                  showNotification("Factory Studio Defaults Restored");
                }}
              >
                <RotateCcw size={13} />
                <span>Restore Factory Studio Defaults</span>
              </button>
            </div>
          )}
        </div>
      </section>
    );
  }

  return (
    <main className={`widget-root dock-${dockSide}`} style={getThemeCssVars()}>
      <button
        className={`widget dock-${dockSide} shape-${settings.orbShape} size-${settings.orbSize} mode-${mode} kind-${activeKind} ${
          settings.theme !== "auto" ? "custom-theme" : ""
        } ${isDragging ? "dragging" : ""} ${switching ? "switching" : ""} ${isIdle ? "idle" : ""} ${
          isAudioPresent ? "audio-live" : ""
        }`}
        aria-label={mode === "output" ? "Cycle audio output" : "Cycle microphone input"}
        title={`${mode === "output" ? "Output" : "Mic"}: ${
          activeDevice?.name ?? "None"
        } • Vol ${Math.round(telemetry.volume * 100)}% (Scroll: Volume, Middle-Click: Mute, Right-Click: Studio Console)`}
        onClick={handlePrimaryOrbClick}
        onWheel={handleOrbWheel}
        onAuxClick={handleOrbAuxClick}
        onContextMenu={handleOrbContextMenu}
        onMouseEnter={() => setIsIdle(false)}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {settings.showPulseWaves && (
          <>
            <span className="edge-wave edge-wave-one" />
            <span className="edge-wave edge-wave-two" />
          </>
        )}

        {settings.showVolumeRing && (
          <span className="orb-volume-ring" aria-hidden="true" />
        )}

        <span className="widget-ripple" />
        <span
          className="device-glyph"
          key={`${mode}-${activeDevice?.id ?? "empty"}-${activeKind}-${settings.logoStyle}`}
        >
          <FloatingLogoGlyph
            settings={settings}
            mode={mode}
            kind={activeKind}
            spinning={shouldSpin}
            barsActive={isAudioPresent}
            peak={effectivePeak}
            muted={telemetry.muted}
          />
        </span>
        <span className="mode-dot" title={mode === "output" ? "Output" : "Input"} />
      </button>

      {settings.showQuickControls && (
        <>
          <button
            className={`mode-toggle dock-${dockSide} mode-${mode}`}
            aria-label={mode === "output" ? "Switch to microphone mode" : "Switch to audio output mode"}
            title={mode === "output" ? "Flip to Microphone Deck" : "Flip to Output Deck"}
            onClick={toggleMode}
          >
            <ChevronRight size={14} strokeWidth={2.6} />
          </button>

          <button
            className={`settings-toggle dock-${dockSide}`}
            aria-label="Open AudioCycle Studio Console"
            title="Open Studio Console (Alt+Shift+S)"
            onClick={() => toggleControlPanel(true)}
          >
            <Settings2 size={13} strokeWidth={2.3} />
          </button>
        </>
      )}

      {settings.showTooltip && (
        <div className="tooltip" role="status">
          <Waves size={12} className="tooltip-wave-icon" />
          <div className="tooltip-text">
            <span className="tooltip-device">
              {activeDevice?.name ?? `No ${mode === "output" ? "outputs" : "mics"}`}
            </span>
            <span className="tooltip-meta">
              {telemetry.muted ? "MUTED" : `VOL ${Math.round(telemetry.volume * 100)}%`} •{" "}
              {getDeviceKindLabel(activeKind, mode)}
            </span>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}
