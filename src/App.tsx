import { invoke } from "@tauri-apps/api/core";
import { LogicalPosition, LogicalSize, getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
  AudioWaveform,
  Bluetooth,
  Check,
  ChevronRight,
  CircleDot,
  Headphones,
  Mic,
  MonitorSpeaker,
  Music2,
  Palette,
  Power,
  RefreshCw,
  RotateCcw,
  Settings2,
  Sliders,
  Sparkles,
  Speaker,
  Volume2,
  Waves,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

type AudioDevice = {
  id: string;
  name: string;
  is_default: boolean;
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
export type ThemePreset = "auto" | "cyber" | "sunset" | "emerald" | "royal" | "mono" | "custom";
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
const SETTINGS_KEY = "audiocycle.settings.v1";
const SNAP_MARGIN = 12;
const COMPACT_WINDOW_WIDTH = 228;
const COMPACT_WINDOW_HEIGHT = 150;
const PANEL_WINDOW_WIDTH = 376;
const PANEL_WINDOW_HEIGHT = 510;

const SIZE_MAP: Record<OrbSize, number> = {
  compact: 48,
  normal: 58,
  large: 68,
};

const THEME_COLORS: Record<Exclude<ThemePreset, "auto" | "custom">, [string, string]> = {
  cyber: ["#67e8f9", "#a78bfa"],
  sunset: ["#fb7185", "#fbbf24"],
  emerald: ["#34d399", "#2dd4bf"],
  royal: ["#c084fc", "#60a5fa"],
  mono: ["#f8fafc", "#94a3b8"],
};

const DEFAULT_SETTINGS: AppSettings = {
  logoStyle: "vinyl",
  customBadge: "AC",
  orbShape: "squircle",
  orbSize: "normal",
  theme: "auto",
  customAccentA: "#67e8f9",
  customAccentB: "#a78bfa",
  showEqBars: true,
  showPulseWaves: true,
  spinBehavior: "activity",
  clickAction: "cycle-current",
  rightClickAction: "open-panel",
  snapToEdges: true,
  idleAutoDim: true,
  idleOpacity: 0.38,
  showTooltip: true,
  showToast: true,
  showQuickControls: true,
  excludedDeviceIds: [],
};

const FALLBACK_OUTPUTS: AudioDevice[] = [
  { id: "out-headphones", name: "Studio Wireless Headphones", is_default: true },
  { id: "out-speakers", name: "Realtek Desktop Speakers", is_default: false },
  { id: "out-monitor", name: "LG UltraGear HDMI Display", is_default: false },
];

const FALLBACK_INPUTS: AudioDevice[] = [
  { id: "in-mic-usb", name: "HyperX QuadCast USB Mic", is_default: true },
  { id: "in-headset", name: "Wireless Headset Microphone", is_default: false },
];

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
    const saved = localStorage.getItem(SETTINGS_KEY);
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

function getNearestMonitor(point: WidgetPosition, monitors: MonitorBounds[], orbPixels = 58): MonitorBounds {
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

  if (name.includes("bluetooth") || name.includes("bt ")) return "bluetooth";
  if (name.includes("headphone") || name.includes("headset") || name.includes("earbud")) return "headphones";
  if (
    name.includes("monitor") ||
    name.includes("display") ||
    name.includes("hdmi") ||
    name.includes("nvidia") ||
    name.includes("amd high definition")
  ) {
    return "monitor";
  }
  if (name.includes("speaker") || name.includes("realtek")) return "speaker";

  return "default";
}

function DeviceIcon({ kind, size = 22 }: { kind: DeviceKind; size?: number }) {
  const iconProps = { size, strokeWidth: 2.2 };

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
      return <Power size={size - 1} strokeWidth={2.2} />;
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
}: {
  settings: AppSettings;
  mode: CycleMode;
  kind: DeviceKind;
  spinning: boolean;
  barsActive: boolean;
}) {
  const iconSize = settings.orbSize === "compact" ? 20 : settings.orbSize === "large" ? 27 : 24;

  return (
    <span className={`audio-mark ${spinning ? "is-spinning" : ""} ${barsActive ? "is-active" : ""}`} aria-hidden="true">
      <span className={`audio-disc style-${settings.logoStyle}`}>
        {settings.logoStyle === "vinyl" && <Music2 size={iconSize} strokeWidth={2.3} />}
        {settings.logoStyle === "device" &&
          (mode === "input" ? (
            <Mic size={iconSize} strokeWidth={2.25} />
          ) : (
            <DeviceIcon kind={kind} size={iconSize} />
          ))}
        {settings.logoStyle === "waveform" && <AudioWaveform size={iconSize} strokeWidth={2.25} />}
        {settings.logoStyle === "minimal" && <CircleDot size={iconSize} strokeWidth={2.25} />}
        {settings.logoStyle === "custom" && (
          <span className="custom-badge-text">{(settings.customBadge || "AC").slice(0, 3)}</span>
        )}
      </span>
      {settings.showEqBars && (
        <span className="audio-bars">
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
      )}
    </span>
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
  const [audioActive, setAudioActive] = useState(false);
  const [toast, setToast] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>("devices");
  const [autostart, setAutostart] = useState(false);

  const dragOffset = useRef({ x: 0, y: 0 });
  const dragStarted = useRef(false);
  const savedOrbPosition = useRef<WidgetPosition | null>(null);

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
  const isAudioPresent = Boolean(activeDevice) && audioActive && !isHidden;

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
      const nextDevices = await invoke<AudioDevice[]>("list_audio_outputs");
      setDevices(nextDevices);
      const nextInputDevices = await invoke<AudioDevice[]>("list_audio_inputs");
      setInputDevices(nextInputDevices);
    } catch {
      // Provide fallback devices in browser preview when Tauri backend is unavailable
      setDevices((current) => (current.length ? current : FALLBACK_OUTPUTS));
      setInputDevices((current) => (current.length ? current : FALLBACK_INPUTS));
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
    refreshDevices();
    refreshMonitors();
    refreshAutostart();

    const poll = window.setInterval(refreshDevices, 5000);
    const activityPoll = window.setInterval(async () => {
      try {
        setAudioActive(await invoke<boolean>("audio_activity"));
      } catch {
        setAudioActive(false);
      }
    }, 350);
    const monitorPoll = window.setInterval(refreshMonitors, 10000);
    const unlisteners = [
      listen("audio-devices-changed", refreshDevices),
      listen("toggle-widget", () => setIsHidden((current) => !current)),
      listen("open-settings", () => {
        setIsHidden(false);
        toggleControlPanel(true);
      }),
    ];

    return () => {
      window.clearInterval(poll);
      window.clearInterval(activityPoll);
      window.clearInterval(monitorPoll);
      unlisteners.forEach((promise) => {
        promise.then((unlisten) => unlisten()).catch(() => undefined);
      });
    };
  }, []);

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
      showNotification(next === "input" ? "Microphone mode" : "Audio output mode");
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
      showNotification(updated.name);
    } catch {
      // Browser preview fallback
      const applyLocal = (list: AudioDevice[]) =>
        list.map((d) => ({ ...d, is_default: d.id === deviceId }));
      const source = targetMode === "output" ? devices : inputDevices;
      const chosen = source.find((d) => d.id === deviceId);
      if (targetMode === "output") {
        setDevices(applyLocal);
      } else {
        setInputDevices(applyLocal);
      }
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
      showNotification(nextDevice.name);
    } catch {
      // Fallback in browser preview
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
        <Volume2 size={17} />
      </button>
    );
  }

  if (panelOpen) {
    return (
      <section className="control-panel" style={getThemeCssVars()}>
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
              />
            </div>
            <div>
              <h1 className="panel-title">AudioCycle Studio</h1>
              <p className="panel-subtitle">
                {mode === "output" ? "Output" : "Mic"}: {activeDevice?.name ?? "No active device"}
              </p>
            </div>
          </div>
          <button
            className="panel-close-btn"
            onClick={() => toggleControlPanel(false)}
            aria-label="Close control panel"
            title="Close (Esc)"
          >
            <X size={15} />
          </button>
        </header>

        <nav className="panel-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={panelTab === "devices"}
            className={`panel-tab ${panelTab === "devices" ? "active" : ""}`}
            onClick={() => setPanelTab("devices")}
          >
            <Volume2 size={14} />
            <span>Devices</span>
          </button>
          <button
            role="tab"
            aria-selected={panelTab === "logo"}
            className={`panel-tab ${panelTab === "logo" ? "active" : ""}`}
            onClick={() => setPanelTab("logo")}
          >
            <Palette size={14} />
            <span>Floating Logo</span>
          </button>
          <button
            role="tab"
            aria-selected={panelTab === "behavior"}
            className={`panel-tab ${panelTab === "behavior" ? "active" : ""}`}
            onClick={() => setPanelTab("behavior")}
          >
            <Sliders size={14} />
            <span>Functions</span>
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
                  <span>Outputs ({devices.length})</span>
                </button>
                <button
                  className={`segment-btn ${mode === "input" ? "active" : ""}`}
                  onClick={() => setMode("input")}
                >
                  <Mic size={13} />
                  <span>Microphones ({inputDevices.length})</span>
                </button>
                <button
                  className="icon-action-btn"
                  onClick={refreshDevices}
                  title="Refresh audio devices"
                  aria-label="Refresh audio devices"
                >
                  <RefreshCw size={13} />
                </button>
              </div>

              <p className="pane-hint">
                Click a device to switch immediately. Uncheck <strong>Cycle</strong> to skip unused endpoints when clicking the floating orb.
              </p>

              <div className="device-list">
                {visibleDevices.map((device) => {
                  const excluded = settings.excludedDeviceIds.includes(device.id);
                  const kind = getDeviceKind(device);
                  return (
                    <div
                      key={device.id}
                      className={`device-card ${device.is_default ? "is-default" : ""} ${
                        excluded ? "is-excluded" : ""
                      }`}
                    >
                      <button
                        className="device-select-btn"
                        onClick={() => selectSpecificDevice(mode, device.id)}
                        title={`Switch to ${device.name}`}
                      >
                        <span className="device-card-icon">
                          {mode === "input" ? <Mic size={16} /> : <DeviceIcon kind={kind} size={16} />}
                        </span>
                        <span className="device-card-info">
                          <span className="device-card-name">{device.name}</span>
                          <span className="device-card-status">
                            {device.is_default ? "Active Default" : "Click to activate"}
                          </span>
                        </span>
                      </button>

                      <button
                        className={`cycle-pill ${!excluded ? "included" : ""}`}
                        onClick={() => toggleDeviceExclusion(device.id)}
                        title={
                          excluded
                            ? "Excluded from 1-click rotation (click to include)"
                            : "Included in 1-click rotation (click to skip)"
                        }
                      >
                        {!excluded && <Check size={11} />}
                        <span>{excluded ? "Skipped" : "Cycle"}</span>
                      </button>
                    </div>
                  );
                })}
                {visibleDevices.length === 0 && (
                  <div className="empty-state">No active {mode} devices detected.</div>
                )}
              </div>
            </div>
          )}

          {panelTab === "logo" && (
            <div className="tab-pane">
              <div className="field-group">
                <label className="field-label">Logo Emblem Style</label>
                <div className="choice-grid cols-3">
                  {(
                    [
                      { id: "vinyl", label: "Vinyl Disc" },
                      { id: "device", label: "Device Icon" },
                      { id: "waveform", label: "Waveform" },
                      { id: "minimal", label: "Neon Core" },
                      { id: "custom", label: "Custom Text" },
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
                  <span className="field-label">Custom Badge (1–3 chars / emoji)</span>
                  <input
                    type="text"
                    maxLength={3}
                    value={settings.customBadge}
                    onChange={(e) => updateSetting("customBadge", e.target.value)}
                    className="badge-input"
                    placeholder="AC"
                  />
                </div>
              )}

              <div className="field-group">
                <label className="field-label">Floating Orb Shape & Size</label>
                <div className="choice-grid cols-3">
                  {(
                    [
                      { id: "squircle", label: "Squircle" },
                      { id: "circle", label: "Circle" },
                      { id: "rounded", label: "Soft Box" },
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
                      { id: "compact", label: "Small (48px)" },
                      { id: "normal", label: "Medium (58px)" },
                      { id: "large", label: "Large (68px)" },
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
                <label className="field-label">Accent Color Theme</label>
                <div className="choice-grid cols-3">
                  {(
                    [
                      { id: "auto", label: "Auto Device" },
                      { id: "cyber", label: "Cyber Cyan" },
                      { id: "sunset", label: "Sunset Rose" },
                      { id: "emerald", label: "Emerald" },
                      { id: "royal", label: "Royal Violet" },
                      { id: "mono", label: "Monochrome" },
                      { id: "custom", label: "Custom Colors" },
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
                      <span>Primary</span>
                      <input
                        type="color"
                        value={settings.customAccentA}
                        onChange={(e) => updateSetting("customAccentA", e.target.value)}
                      />
                    </label>
                    <label className="color-picker-item">
                      <span>Secondary</span>
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
                <label className="field-label">Spin & Equalizer Animations</label>
                <div className="choice-grid cols-3">
                  {(
                    [
                      { id: "activity", label: "Spin on Audio" },
                      { id: "always", label: "Always Spin" },
                      { id: "off", label: "No Spin" },
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
                    <span>Show Mini Equalizer Bars</span>
                    <input
                      type="checkbox"
                      checked={settings.showEqBars}
                      onChange={(e) => updateSetting("showEqBars", e.target.checked)}
                    />
                  </label>
                  <label className="toggle-row">
                    <span>Outer Pulse Wave Rings</span>
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
              <div className="field-group">
                <label className="field-label">Left-Click Orb Action</label>
                <select
                  className="panel-select"
                  value={settings.clickAction}
                  onChange={(e) => updateSetting("clickAction", e.target.value as ClickAction)}
                >
                  <option value="cycle-current">Cycle Active Mode (Output or Mic)</option>
                  <option value="cycle-output">Always Cycle Audio Outputs</option>
                  <option value="cycle-input">Always Cycle Microphones</option>
                  <option value="open-panel">Open Control Panel</option>
                </select>
              </div>

              <div className="field-group">
                <label className="field-label">Right-Click Orb Action</label>
                <select
                  className="panel-select"
                  value={settings.rightClickAction}
                  onChange={(e) => updateSetting("rightClickAction", e.target.value as RightClickAction)}
                >
                  <option value="open-panel">Open Control Panel</option>
                  <option value="toggle-mode">Switch Output / Microphone Mode</option>
                  <option value="hide-widget">Hide Floating Widget</option>
                </select>
              </div>

              <div className="toggle-list">
                <label className="toggle-row">
                  <span>Snap Orb to Left / Right Screen Edge</span>
                  <input
                    type="checkbox"
                    checked={settings.snapToEdges}
                    onChange={(e) => updateSetting("snapToEdges", e.target.checked)}
                  />
                </label>

                <label className="toggle-row">
                  <span>Show Side Mode & Settings Buttons</span>
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
                  <span>Show Device Name Tooltip on Hover</span>
                  <input
                    type="checkbox"
                    checked={settings.showTooltip}
                    onChange={(e) => updateSetting("showTooltip", e.target.checked)}
                  />
                </label>

                <label className="toggle-row">
                  <span>Show Toast Notification on Switch</span>
                  <input
                    type="checkbox"
                    checked={settings.showToast}
                    onChange={(e) => updateSetting("showToast", e.target.checked)}
                  />
                </label>

                <label className="toggle-row">
                  <span>Launch AudioCycle on Windows Startup</span>
                  <input type="checkbox" checked={autostart} onChange={toggleAutostart} />
                </label>
              </div>

              <button
                className="reset-btn"
                onClick={() => {
                  setSettings(DEFAULT_SETTINGS);
                  localStorage.setItem(SETTINGS_KEY, JSON.stringify(DEFAULT_SETTINGS));
                  showNotification("Settings restored to defaults");
                }}
              >
                <RotateCcw size={13} />
                <span>Reset All Customizations</span>
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
        } ${isDragging ? "dragging" : ""} ${switching ? "switching" : ""} ${isIdle ? "idle" : ""}`}
        aria-label={mode === "output" ? "Cycle audio output" : "Cycle microphone input"}
        title={`${mode === "output" ? "Output" : "Microphone"}: ${
          activeDevice?.name ?? `No active ${mode === "output" ? "audio outputs" : "microphones"}`
        } (Right-click for Control Panel)`}
        onClick={handlePrimaryOrbClick}
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
        <span className="widget-ripple" />
        <span className="device-glyph" key={`${mode}-${activeDevice?.id ?? "empty"}-${activeKind}-${settings.logoStyle}`}>
          <FloatingLogoGlyph
            settings={settings}
            mode={mode}
            kind={activeKind}
            spinning={shouldSpin}
            barsActive={isAudioPresent}
          />
        </span>
        <span className="mode-dot" title={mode === "output" ? "Output" : "Input"} />
      </button>

      {settings.showQuickControls && (
        <>
          <button
            className={`mode-toggle dock-${dockSide} mode-${mode}`}
            aria-label={mode === "output" ? "Switch to microphone mode" : "Switch to audio output mode"}
            title={mode === "output" ? "Switch to microphone" : "Switch to output"}
            onClick={toggleMode}
          >
            <ChevronRight size={14} strokeWidth={2.6} />
          </button>

          <button
            className={`settings-toggle dock-${dockSide}`}
            aria-label="Open AudioCycle Control Panel"
            title="Open Control Panel (Alt+Shift+S)"
            onClick={() => toggleControlPanel(true)}
          >
            <Settings2 size={13} strokeWidth={2.3} />
          </button>
        </>
      )}

      {settings.showTooltip && (
        <div className="tooltip" role="status">
          <Waves size={12} />
          <span>
            {mode === "output" ? "Output" : "Mic"}:{" "}
            {activeDevice?.name ?? `No active ${mode === "output" ? "audio outputs" : "microphones"}`}
          </span>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}
