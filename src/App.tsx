import { invoke } from "@tauri-apps/api/core";
import { LogicalPosition, LogicalSize, getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
  Bluetooth,
  Headphones,
  Mic,
  MicOff,
  MonitorSpeaker,
  Power,
  Speaker,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

type AudioDevice = { id: string; name: string; is_default: boolean };

type AudioTelemetry = {
  peak: number;
  peak_l: number;
  peak_r: number;
  volume: number;
  muted: boolean;
  active: boolean;
};

type WidgetPosition = { x: number; y: number };
type MonitorBounds = { x: number; y: number; width: number; height: number };

type DeviceKind = "headphones" | "speaker" | "monitor" | "bluetooth" | "default" | "empty";
type CycleMode = "output" | "input";
type DockSide = "left" | "right";
type PanelView = "devices" | "settings";

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

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const POSITION_KEY = "audiocycle.widget-position";
const SETTINGS_KEY = "audiocycle.settings.v3";
const SNAP_MARGIN = 12;
const COMPACT_WINDOW_WIDTH = 236;
const COMPACT_WINDOW_HEIGHT = 156;
const PANEL_WINDOW_WIDTH = 360;
const PANEL_WINDOW_HEIGHT = 540;
const RING_DOTS = 36;

const SIZE_MAP: Record<OrbSize, number> = { compact: 52, normal: 62, large: 72 };

const ACCENTS: Record<Accent, string> = {
  signal: "#ff4f1f",
  white: "#f2f2f2",
  lime: "#c6ff3d",
  blue: "#4d7cff",
};

const DEFAULT_SETTINGS: AppSettings = {
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

const FALLBACK_OUTPUTS: AudioDevice[] = [
  { id: "out-1", name: "Headphones (DAC)", is_default: true },
  { id: "out-2", name: "Desktop Speakers", is_default: false },
  { id: "out-3", name: "HDMI Display Audio", is_default: false },
  { id: "out-4", name: "Bluetooth Headset", is_default: false },
];

const FALLBACK_INPUTS: AudioDevice[] = [
  { id: "in-1", name: "USB Microphone", is_default: true },
  { id: "in-2", name: "Headset Microphone", is_default: false },
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

let toneCtx: AudioContext | null = null;
function playTone(mode: CycleMode, enabled: boolean) {
  if (!enabled) return;
  try {
    toneCtx ??= new AudioContext();
    if (toneCtx.state === "suspended") void toneCtx.resume();
    const t = toneCtx.currentTime;
    const notes = mode === "output" ? [880, 1318.5] : [660, 880];
    notes.forEach((freq, i) => {
      const osc = toneCtx!.createOscillator();
      const gain = toneCtx!.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const s = t + i * 0.06;
      gain.gain.setValueAtTime(0.0001, s);
      gain.gain.exponentialRampToValueAtTime(0.05, s + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, s + 0.14);
      osc.connect(gain).connect(toneCtx!.destination);
      osc.start(s);
      osc.stop(s + 0.16);
    });
  } catch {
    // Audio context unavailable.
  }
}

function loadPosition(): WidgetPosition {
  try {
    const saved = localStorage.getItem(POSITION_KEY);
    if (saved) return JSON.parse(saved) as WidgetPosition;
  } catch {
    // default
  }
  return { x: 18, y: 180 };
}

function loadSettings(): AppSettings {
  try {
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (saved) return { ...DEFAULT_SETTINGS, ...(JSON.parse(saved) as Partial<AppSettings>) };
  } catch {
    // defaults
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
  const cx = point.x + orbPixels / 2;
  const cy = point.y + orbPixels / 2;
  const dist = (m: MonitorBounds) => {
    const nx = Math.min(Math.max(cx, m.x), m.x + m.width);
    const ny = Math.min(Math.max(cy, m.y), m.y + m.height);
    return (cx - nx) ** 2 + (cy - ny) ** 2;
  };
  return candidates.reduce((best, m) => (dist(m) < dist(best) ? m : best), candidates[0]);
}

function clampPosition(
  point: WidgetPosition,
  monitors: MonitorBounds[],
  winWidth = COMPACT_WINDOW_WIDTH,
  winHeight = COMPACT_WINDOW_HEIGHT,
): WidgetPosition {
  const m = getNearestMonitor(point, monitors);
  const minX = m.x;
  const maxX = m.x + m.width - winWidth;
  const minY = m.y + SNAP_MARGIN;
  const maxY = m.y + m.height - winHeight - SNAP_MARGIN;
  return {
    x: Math.min(Math.max(point.x, minX), Math.max(minX, maxX)),
    y: Math.min(Math.max(point.y, minY), Math.max(minY, maxY)),
  };
}

function snapToSide(point: WidgetPosition, monitors: MonitorBounds[], snapEnabled: boolean): WidgetPosition {
  const clamped = clampPosition(point, monitors);
  if (!snapEnabled) return clamped;
  const m = getNearestMonitor(clamped, monitors);
  const centerX = clamped.x + COMPACT_WINDOW_WIDTH / 2;
  return { ...clamped, x: centerX < m.x + m.width / 2 ? m.x : m.x + m.width - COMPACT_WINDOW_WIDTH };
}

function getDockSide(position: WidgetPosition, monitors: MonitorBounds[], orbPixels: number): DockSide {
  const m = getNearestMonitor(position, monitors, orbPixels);
  return position.x + orbPixels / 2 < m.x + m.width / 2 ? "left" : "right";
}

function getDeviceKind(device?: AudioDevice): DeviceKind {
  if (!device) return "empty";
  const n = device.name.toLowerCase();
  if (n.includes("bluetooth") || n.includes("bt ") || n.includes("airpods")) return "bluetooth";
  if (n.includes("headphone") || n.includes("headset") || n.includes("earbud")) return "headphones";
  if (n.includes("monitor") || n.includes("display") || n.includes("hdmi") || n.includes("nvidia")) return "monitor";
  if (n.includes("speaker") || n.includes("realtek")) return "speaker";
  return "default";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function DeviceIcon({ kind, mode, muted, size = 20 }: { kind: DeviceKind; mode: CycleMode; muted?: boolean; size?: number }) {
  const p = { size, strokeWidth: 1.5 };
  if (mode === "input") return muted ? <MicOff {...p} /> : <Mic {...p} />;
  if (muted) return <VolumeX {...p} />;
  switch (kind) {
    case "bluetooth":
      return <Bluetooth {...p} />;
    case "headphones":
      return <Headphones {...p} />;
    case "monitor":
      return <MonitorSpeaker {...p} />;
    case "speaker":
      return <Speaker {...p} />;
    case "empty":
      return <Power {...p} />;
    default:
      return <Volume2 {...p} />;
  }
}

/** Dot-matrix ring that doubles as a volume dial. */
function DotRing({ size, level, muted, live }: { size: number; level: number; muted: boolean; live: boolean }) {
  const c = size / 2;
  const r = c - 5;
  const lit = muted ? 0 : Math.round(level * RING_DOTS);
  return (
    <svg className={`dot-ring ${live ? "live" : ""}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      {Array.from({ length: RING_DOTS }).map((_, i) => {
        const a = (i / RING_DOTS) * Math.PI * 2 - Math.PI / 2;
        return (
          <circle
            key={i}
            cx={c + Math.cos(a) * r}
            cy={c + Math.sin(a) * r}
            r={1.35}
            className={i < lit ? "dot on" : "dot"}
          />
        );
      })}
    </svg>
  );
}

/**
 * Row of box cells. Filled cells = volume (accent). While audio plays,
 * the cells up to the live signal level light up brighter, so the bar
 * shows both how loud the device is set and what is passing through it.
 */
function LevelMeter({
  volume,
  signal,
  muted,
  live,
}: {
  volume: number;
  signal: number;
  muted: boolean;
  live: boolean;
}) {
  const cells = 32;
  const volCells = muted ? 0 : Math.round(volume * cells);
  const sigCells = live ? Math.min(volCells, Math.max(1, Math.round(Math.pow(signal, 0.5) * volCells))) : 0;
  return (
    <div className={`meter ${live ? "live" : ""} ${muted ? "muted" : ""}`} aria-hidden="true">
      {Array.from({ length: cells }).map((_, i) => (
        <i key={i} className={i < sigCells ? "sig" : i < volCells ? "vol" : ""} />
      ))}
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="row-toggle" onClick={() => onChange(!checked)}>
      <span>{label}</span>
      <span className={`switch ${checked ? "on" : ""}`}>
        <i />
      </span>
    </button>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          className={value === o.id ? "active" : ""}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

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
  const [liveHold, setLiveHold] = useState(false);
  const [meterLevel, setMeterLevel] = useState(0);
  const [toast, setToast] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelView, setPanelView] = useState<PanelView>("devices");
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
  const activeDevice = visibleDevices.find((d) => d.is_default) ?? visibleDevices[0];
  const activeKind = getDeviceKind(activeDevice);
  const dockSide = getDockSide(position, monitors, orbPixels);
  const liveRaw = Boolean(activeDevice) && telemetry.active && !telemetry.muted && !isHidden;
  const live = liveHold && !telemetry.muted;
  const volumePct = Math.round((telemetry.muted ? 0 : telemetry.volume) * 100);

  function notify(message: string) {
    if (settings.showToast) setToast(message);
  }

  function updateSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setSettings((current) => {
      const next = { ...current, [key]: value };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      return next;
    });
  }

  /* ---------------- backend calls ---------------- */

  async function refreshDevices() {
    try {
      const [o, i] = await Promise.all([
        invoke<AudioDevice[]>("list_audio_outputs"),
        invoke<AudioDevice[]>("list_audio_inputs"),
      ]);
      setDevices(o);
      setInputDevices(i);
    } catch {
      setDevices((c) => (c.length ? c : FALLBACK_OUTPUTS));
      setInputDevices((c) => (c.length ? c : FALLBACK_INPUTS));
    }
  }

  async function refreshTelemetry(target = modeRef.current) {
    try {
      setTelemetry(await invoke<AudioTelemetry>("get_audio_telemetry", { mode: target }));
    } catch {
      // browser preview
    }
  }

  async function handleVolumeChange(level: number) {
    const v = Math.min(1, Math.max(0, level));
    setTelemetry((p) => ({ ...p, volume: v, muted: v <= 0.005 ? p.muted : false }));
    try {
      setTelemetry(await invoke<AudioTelemetry>("set_device_volume", { mode, level: v }));
    } catch {
      // local state already updated
    }
  }

  async function handleToggleMute() {
    const next = !telemetry.muted;
    setTelemetry((p) => ({ ...p, muted: next }));
    notify(next ? "Muted" : `Unmuted ${Math.round(telemetry.volume * 100)}`);
    try {
      setTelemetry(await invoke<AudioTelemetry>("set_device_mute", { mode, muted: next }));
    } catch {
      // local state already updated
    }
  }

  async function refreshMonitors() {
    try {
      setMonitors(await invoke<MonitorBounds[]>("list_monitors"));
    } catch {
      setMonitors([FALLBACK_MONITOR]);
    }
  }

  async function refreshAutostart() {
    try {
      setAutostart(await invoke<boolean>("get_autostart"));
    } catch {
      // browser preview
    }
  }

  async function toggleAutostart() {
    try {
      setAutostart(await invoke<boolean>("set_autostart", { enabled: !autostart }));
    } catch {
      setAutostart((p) => !p);
    }
  }

  async function applyWindowDimensions(open: boolean) {
    const w = open ? PANEL_WINDOW_WIDTH : COMPACT_WINDOW_WIDTH;
    const h = open ? PANEL_WINDOW_HEIGHT : COMPACT_WINDOW_HEIGHT;
    try {
      await invoke("set_window_size", { width: w, height: h });
    } catch {
      try {
        await appWindow?.setSize(new LogicalSize(w, h));
      } catch {
        // browser preview
      }
    }
    if (open) {
      savedOrbPosition.current = position;
      const clamped = clampPosition(position, monitors, PANEL_WINDOW_WIDTH, PANEL_WINDOW_HEIGHT);
      if (clamped.x !== position.x || clamped.y !== position.y) setPosition(clamped);
    } else if (savedOrbPosition.current) {
      const restored = snapToSide(savedOrbPosition.current, monitors, settings.snapToEdges);
      savedOrbPosition.current = null;
      setPosition(restored);
    }
  }

  function toggleControlPanel(force?: boolean) {
    setPanelOpen((current) => {
      const next = force ?? !current;
      void applyWindowDimensions(next);
      return next;
    });
  }

  /* ---------------- effects ---------------- */

  useEffect(() => {
    void refreshDevices();
    void refreshMonitors();
    void refreshAutostart();
    void refreshTelemetry();

    const telemetryTimer = window.setInterval(() => void refreshTelemetry(), panelOpen ? 100 : 160);
    const monitorTimer = window.setInterval(refreshMonitors, 12000);
    const unlisteners = [
      listen("audio-devices-changed", () => {
        void refreshDevices();
        void refreshTelemetry();
      }),
      listen("toggle-widget", () => setIsHidden((c) => !c)),
      listen("cycle-active-shortcut", () => void cycleTargetMode(modeRef.current)),
      listen("open-settings", () => {
        setIsHidden(false);
        toggleControlPanel(true);
      }),
    ];
    return () => {
      window.clearInterval(telemetryTimer);
      window.clearInterval(monitorTimer);
      unlisteners.forEach((p) => p.then((u) => u()).catch(() => undefined));
    };
  }, [panelOpen]);

  useEffect(() => {
    void refreshTelemetry(mode);
  }, [mode]);

  // Hold the "live" state through short silences so the indicator doesn't flicker.
  useEffect(() => {
    if (liveRaw) {
      setLiveHold(true);
      return;
    }
    const t = window.setTimeout(() => setLiveHold(false), 700);
    return () => window.clearTimeout(t);
  }, [liveRaw]);

  // Meter ballistics: fast attack, slow release.
  useEffect(() => {
    const target = telemetry.muted ? 0 : Math.max(telemetry.peak_l, telemetry.peak_r, telemetry.peak);
    setMeterLevel((prev) => (target >= prev ? target : prev * 0.72 + target * 0.28));
  }, [telemetry]);

  useEffect(() => {
    if (!settings.idleAutoDim || panelOpen || switching || isDragging || toast) {
      setIsIdle(false);
      return;
    }
    const t = window.setTimeout(() => setIsIdle(true), 2600);
    return () => window.clearTimeout(t);
  }, [settings.idleAutoDim, panelOpen, isDragging, switching, toast, activeDevice?.id, mode]);

  useEffect(() => {
    localStorage.setItem(POSITION_KEY, JSON.stringify(position));
    appWindow?.setPosition(new LogicalPosition(position.x, position.y)).catch(() => undefined);
  }, [appWindow, position]);

  useEffect(() => {
    if (!panelOpen) setPosition((c) => snapToSide(c, monitors, settings.snapToEdges));
  }, [monitors, settings.snapToEdges]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(""), 1600);
    return () => window.clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.altKey && e.shiftKey && e.code === "KeyA") setIsHidden((c) => !c);
      else if (e.altKey && e.shiftKey && e.code === "KeyS") toggleControlPanel();
      else if (e.altKey && e.shiftKey && e.code === "KeyC") void cycleTargetMode(modeRef.current);
      else if (e.key === "Escape" && panelOpen) toggleControlPanel(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelOpen]);

  /* ---------------- actions ---------------- */

  function toggleMode() {
    setMode((current) => {
      const next = current === "output" ? "input" : "output";
      playTone(next, settings.switchTone);
      notify(next === "input" ? "Input" : "Output");
      return next;
    });
  }

  async function selectSpecificDevice(target: CycleMode, id: string) {
    setSwitching(true);
    const apply = (list: AudioDevice[]) => list.map((d) => ({ ...d, is_default: d.id === id }));
    try {
      const updated = await invoke<AudioDevice>(target === "output" ? "set_audio_output" : "set_audio_input", { id });
      target === "output" ? setDevices(apply) : setInputDevices(apply);
      notify(updated.name);
      void refreshTelemetry(target);
    } catch {
      target === "output" ? setDevices(apply) : setInputDevices(apply);
      const chosen = (target === "output" ? devices : inputDevices).find((d) => d.id === id);
      if (chosen) notify(chosen.name);
    } finally {
      playTone(target, settings.switchTone);
      window.setTimeout(() => setSwitching(false), 220);
    }
  }

  async function cycleTargetMode(target: CycleMode) {
    if (switching) return;
    const pool = target === "output" ? devices : inputDevices;
    const enabled = pool.filter((d) => !settings.excludedDeviceIds.includes(d.id));
    const effective = enabled.length > 0 ? enabled : pool;

    if (effective.length > 0 && settings.excludedDeviceIds.length > 0) {
      const idx = effective.findIndex((d) => d.is_default);
      await selectSpecificDevice(target, effective[(idx + 1) % effective.length].id);
      return;
    }

    setSwitching(true);
    try {
      const next = await invoke<AudioDevice>(target === "output" ? "cycle_audio_output" : "cycle_audio_input");
      const apply = (list: AudioDevice[]) => list.map((d) => ({ ...d, is_default: d.id === next.id }));
      target === "output" ? setDevices(apply) : setInputDevices(apply);
      playTone(target, settings.switchTone);
      notify(next.name);
      void refreshTelemetry(target);
    } catch {
      if (effective.length > 0) {
        const idx = effective.findIndex((d) => d.is_default);
        await selectSpecificDevice(target, effective[(idx + 1) % effective.length].id);
      }
    } finally {
      window.setTimeout(() => setSwitching(false), 220);
    }
  }

  async function handlePrimaryClick() {
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

  function handleWheel(e: React.WheelEvent) {
    if (!settings.wheelVolumeControl) return;
    const next = Math.min(1, Math.max(0, telemetry.volume + (e.deltaY < 0 ? 0.04 : -0.04)));
    void handleVolumeChange(next);
    notify(`${Math.round(next * 100)}`);
  }

  function handleAuxClick(e: React.MouseEvent) {
    if (e.button === 1) {
      e.preventDefault();
      void handleToggleMute();
    }
  }

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    if (settings.rightClickAction === "open-panel") toggleControlPanel();
    else if (settings.rightClickAction === "toggle-mode") toggleMode();
    else setIsHidden(true);
  }

  function toggleDeviceExclusion(id: string) {
    const has = settings.excludedDeviceIds.includes(id);
    updateSetting(
      "excludedDeviceIds",
      has ? settings.excludedDeviceIds.filter((x) => x !== id) : [...settings.excludedDeviceIds, id],
    );
  }

  /* ---------------- dragging ---------------- */

  function startDrag(e: React.PointerEvent<HTMLElement>) {
    if (e.button !== 0) return;
    if (e.currentTarget.tagName !== "BUTTON" && (e.target as HTMLElement).closest("button, input, select, a")) return;
    dragStarted.current = false;
    dragOffset.current = { x: e.screenX - position.x, y: e.screenY - position.y };
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsDragging(true);
  }

  function moveDrag(e: React.PointerEvent<HTMLElement>) {
    if (!isDragging) return;
    const w = panelOpen ? PANEL_WINDOW_WIDTH : COMPACT_WINDOW_WIDTH;
    const h = panelOpen ? PANEL_WINDOW_HEIGHT : COMPACT_WINDOW_HEIGHT;
    const next = clampPosition(
      { x: e.screenX - dragOffset.current.x, y: e.screenY - dragOffset.current.y },
      monitors,
      w,
      h,
    );
    if (Math.abs(next.x - position.x) > 2 || Math.abs(next.y - position.y) > 2) dragStarted.current = true;
    setPosition(next);
  }

  function endDrag(e: React.PointerEvent<HTMLElement>) {
    if (!isDragging) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setIsDragging(false);
    if (!panelOpen) setPosition((c) => snapToSide(c, monitors, settings.snapToEdges));
    window.setTimeout(() => {
      dragStarted.current = false;
    }, 0);
  }

  const cssVars = {
    "--accent": ACCENTS[settings.accent],
    "--orb": `${orbPixels}px`,
    "--vol": `${volumePct}%`,
    "--peak": String(meterLevel),
  } as React.CSSProperties;

  /* ---------------- render ---------------- */

  if (isHidden) {
    return (
      <button className="restore" style={cssVars} onClick={() => setIsHidden(false)} aria-label="Show AudioCycle">
        <i />
      </button>
    );
  }

  if (panelOpen) {
    return (
      <section className="panel" style={cssVars}>
        <header className="panel-head" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
          <div className="brand">
            <span className={`status-dot ${live ? "live" : ""}`} />
            <span className="label">AudioCycle</span>
          </div>
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { id: "output", label: "Out" },
              { id: "input", label: "In" },
            ]}
          />
          <button
            type="button"
            className="icon-btn"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => toggleControlPanel(false)}
            aria-label="Close"
            title="Close (Esc)"
          >
            <X size={15} strokeWidth={1.5} />
          </button>
        </header>

        <div className="hero">
          <div className="hero-top">
            <span className={`live-chip ${live ? "on" : ""}`}>
              <i />
              {telemetry.muted ? "Muted" : live ? (mode === "output" ? "Playing" : "Hearing") : "Silent"}
            </span>
            <button type="button" className={`mute ${telemetry.muted ? "on" : ""}`} onClick={handleToggleMute}>
              {telemetry.muted ? "Muted" : "Mute"}
            </button>
          </div>
          <div className="readout">
            <span className={`readout-num ${telemetry.muted ? "dim" : ""}`}>{pad2(volumePct)}</span>
            <span className="readout-unit">%</span>
          </div>
          <p className="hero-device">{activeDevice?.name ?? "No device"}</p>
          <LevelMeter
            volume={telemetry.volume}
            signal={meterLevel}
            muted={telemetry.muted}
            live={live}
          />
          <input
            type="range"
            className="slider"
            min={0}
            max={1}
            step={0.01}
            value={telemetry.muted ? 0 : telemetry.volume}
            onChange={(e) => void handleVolumeChange(parseFloat(e.target.value))}
            aria-label="Volume"
          />
        </div>

        <nav className="tabs" role="tablist">
          <button role="tab" aria-selected={panelView === "devices"} className={panelView === "devices" ? "active" : ""} onClick={() => setPanelView("devices")}>
            Devices <sup>{pad2(visibleDevices.length)}</sup>
          </button>
          <button role="tab" aria-selected={panelView === "settings"} className={panelView === "settings" ? "active" : ""} onClick={() => setPanelView("settings")}>
            Settings
          </button>
        </nav>

        <div className="panel-body">
          {panelView === "devices" && (
            <>
              <ul className="devices">
                {visibleDevices.map((d, i) => {
                  const excluded = settings.excludedDeviceIds.includes(d.id);
                  return (
                    <li key={d.id} className={`device ${d.is_default ? "active" : ""} ${excluded ? "skipped" : ""}`}>
                      <button className="device-main" onClick={() => void selectSpecificDevice(mode, d.id)} title={`Switch to ${d.name}`}>
                        <span className="idx">{pad2(i + 1)}</span>
                        <span className="device-name">{d.name}</span>
                        {d.is_default && <span className="badge">Active</span>}
                      </button>
                      <button
                        className={`loop ${excluded ? "" : "on"}`}
                        onClick={() => toggleDeviceExclusion(d.id)}
                        title={excluded ? "Skipped when cycling. Click to include" : "Included when cycling. Click to skip"}
                        aria-pressed={!excluded}
                      >
                        <i />
                      </button>
                    </li>
                  );
                })}
                {visibleDevices.length === 0 && <li className="empty">No {mode} devices found</li>}
              </ul>
              <p className="hint">Square = included in click-to-cycle.</p>
            </>
          )}

          {panelView === "settings" && (
            <div className="settings">
              <section>
                <h3 className="label">Appearance</h3>
                <div className="field">
                  <span>Accent</span>
                  <div className="swatches">
                    {(Object.keys(ACCENTS) as Accent[]).map((a) => (
                      <button
                        key={a}
                        className={`swatch ${settings.accent === a ? "active" : ""}`}
                        style={{ background: ACCENTS[a] }}
                        onClick={() => updateSetting("accent", a)}
                        aria-label={a}
                        title={a}
                      />
                    ))}
                  </div>
                </div>
                <div className="field">
                  <span>Shape</span>
                  <Segmented
                    value={settings.orbShape}
                    onChange={(v) => updateSetting("orbShape", v)}
                    options={[
                      { id: "circle", label: "Round" },
                      { id: "squircle", label: "Soft" },
                      { id: "square", label: "Square" },
                    ]}
                  />
                </div>
                <div className="field">
                  <span>Size</span>
                  <Segmented
                    value={settings.orbSize}
                    onChange={(v) => updateSetting("orbSize", v)}
                    options={[
                      { id: "compact", label: "S" },
                      { id: "normal", label: "M" },
                      { id: "large", label: "L" },
                    ]}
                  />
                </div>
              </section>

              <section>
                <h3 className="label">Behavior</h3>
                <div className="field stacked">
                  <span>Click</span>
                  <select className="select" value={settings.clickAction} onChange={(e) => updateSetting("clickAction", e.target.value as ClickAction)}>
                    <option value="cycle-current">Cycle current</option>
                    <option value="cycle-output">Cycle outputs</option>
                    <option value="cycle-input">Cycle inputs</option>
                    <option value="open-panel">Open panel</option>
                  </select>
                </div>
                <div className="field stacked">
                  <span>Right click</span>
                  <select className="select" value={settings.rightClickAction} onChange={(e) => updateSetting("rightClickAction", e.target.value as RightClickAction)}>
                    <option value="open-panel">Open panel</option>
                    <option value="toggle-mode">Flip output / input</option>
                    <option value="hide-widget">Hide</option>
                  </select>
                </div>
                <Toggle label="Scroll to change volume" checked={settings.wheelVolumeControl} onChange={(v) => updateSetting("wheelVolumeControl", v)} />
                <Toggle label="Switch tone" checked={settings.switchTone} onChange={(v) => updateSetting("switchTone", v)} />
                <Toggle label="Snap to screen edge" checked={settings.snapToEdges} onChange={(v) => updateSetting("snapToEdges", v)} />
                <Toggle label="Fade when idle" checked={settings.idleAutoDim} onChange={(v) => updateSetting("idleAutoDim", v)} />
                <Toggle label="Side buttons" checked={settings.showQuickControls} onChange={(v) => updateSetting("showQuickControls", v)} />
                <Toggle label="Hover tooltip" checked={settings.showTooltip} onChange={(v) => updateSetting("showTooltip", v)} />
                <Toggle label="Switch notification" checked={settings.showToast} onChange={(v) => updateSetting("showToast", v)} />
                <Toggle label="Launch at startup" checked={autostart} onChange={() => void toggleAutostart()} />
              </section>

              <section className="shortcuts">
                <h3 className="label">Shortcuts</h3>
                <dl>
                  <dt>Cycle device</dt>
                  <dd><kbd>Alt</kbd><kbd>Shift</kbd><kbd>C</kbd></dd>
                  <dt>Show / hide</dt>
                  <dd><kbd>Alt</kbd><kbd>Shift</kbd><kbd>A</kbd></dd>
                  <dt>Open panel</dt>
                  <dd><kbd>Alt</kbd><kbd>Shift</kbd><kbd>S</kbd></dd>
                </dl>
              </section>

              <button
                className="reset"
                onClick={() => {
                  setSettings(DEFAULT_SETTINGS);
                  localStorage.setItem(SETTINGS_KEY, JSON.stringify(DEFAULT_SETTINGS));
                  notify("Defaults restored");
                }}
              >
                Reset to defaults
              </button>
            </div>
          )}
        </div>
      </section>
    );
  }

  return (
    <main className={`widget-root dock-${dockSide}`} style={cssVars}>
      <button
        className={`pod shape-${settings.orbShape} ${isDragging ? "dragging" : ""} ${switching ? "switching" : ""} ${isIdle ? "idle" : ""} ${live ? "live" : ""} ${mode === "input" ? "is-input" : ""}`}
        aria-label={mode === "output" ? "Cycle audio output" : "Cycle microphone"}
        onClick={handlePrimaryClick}
        onWheel={handleWheel}
        onAuxClick={handleAuxClick}
        onContextMenu={handleContextMenu}
        onMouseEnter={() => setIsIdle(false)}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <DotRing size={orbPixels} level={telemetry.volume} muted={telemetry.muted} live={live} />
        <span className="pod-icon" key={`${mode}-${activeDevice?.id ?? "none"}`}>
          <DeviceIcon kind={activeKind} mode={mode} muted={telemetry.muted} size={orbPixels * 0.34} />
        </span>
        <span className="pod-badge" aria-hidden="true" />
      </button>

      {settings.showQuickControls && (
        <div className="side-controls">
          <button onClick={toggleMode} title={mode === "output" ? "Switch to input" : "Switch to output"} aria-label="Flip output / input">
            {mode === "output" ? "OUT" : "IN"}
          </button>
          <button onClick={() => toggleControlPanel(true)} title="Open panel (Alt+Shift+S)" aria-label="Open panel">
            ···
          </button>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}

      {settings.showTooltip && (
        <div className="tooltip" role="status">
          <span className="tooltip-name">{activeDevice?.name ?? "No device"}</span>
          <span className="tooltip-meta">
            {mode === "output" ? "OUT" : "IN"} · {telemetry.muted ? "MUTED" : pad2(volumePct)}
          </span>
        </div>
      )}
    </main>
  );
}
