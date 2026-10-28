import { invoke } from "@tauri-apps/api/core";
import { LogicalPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
  Bluetooth,
  ChevronRight,
  Headphones,
  MonitorSpeaker,
  Power,
  Mic,
  Settings,
  Speaker,
  Volume2,
  Music2,
  Waves,
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

const POSITION_KEY = "audiocycle.widget-position";
const SNAP_MARGIN = 12;
const WINDOW_WIDTH = 228;
const WINDOW_HEIGHT = 150;
const WIDGET_WIDTH = 58;
const WIDGET_HEIGHT = 58;

function loadPosition(): WidgetPosition {
  try {
    const saved = localStorage.getItem(POSITION_KEY);
    if (saved) return JSON.parse(saved) as WidgetPosition;
  } catch {
    // Fall back to the first monitor when saved coordinates are stale.
  }
  return { x: 18, y: 180 };
}

const FALLBACK_MONITOR: MonitorBounds = {
  x: 0,
  y: 0,
  width: window.screen.availWidth,
  height: window.screen.availHeight,
};

function getNearestMonitor(point: WidgetPosition, monitors: MonitorBounds[]): MonitorBounds {
  const candidates = monitors.length ? monitors : [FALLBACK_MONITOR];
  const centerX = point.x + WIDGET_WIDTH / 2;
  const centerY = point.y + WIDGET_HEIGHT / 2;

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

function clampPosition(point: WidgetPosition, monitors: MonitorBounds[]): WidgetPosition {
  const monitor = getNearestMonitor(point, monitors);
  const minX = monitor.x;
  const maxX = monitor.x + monitor.width - WINDOW_WIDTH;
  const minY = monitor.y + SNAP_MARGIN;
  const maxY = monitor.y + monitor.height - WINDOW_HEIGHT - SNAP_MARGIN;

  return {
    x: Math.min(Math.max(point.x, minX), maxX),
    y: Math.min(Math.max(point.y, minY), maxY),
  };
}

function snapToSide(point: WidgetPosition, monitors: MonitorBounds[]): WidgetPosition {
  const clamped = clampPosition(point, monitors);
  const monitor = getNearestMonitor(clamped, monitors);
  const leftX = monitor.x;
  const rightX = monitor.x + monitor.width - WINDOW_WIDTH;
  const centerX = clamped.x + WINDOW_WIDTH / 2;
  const monitorCenterX = monitor.x + monitor.width / 2;

  return {
    ...clamped,
    x: centerX < monitorCenterX ? leftX : rightX,
  };
}

function getDockSide(position: WidgetPosition, monitors: MonitorBounds[]): DockSide {
  const monitor = getNearestMonitor(position, monitors);
  const monitorCenterX = monitor.x + monitor.width / 2;
  return position.x + WIDGET_WIDTH / 2 < monitorCenterX ? "left" : "right";
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

function DeviceIcon({ kind }: { kind: DeviceKind }) {
  const iconProps = { size: 23, strokeWidth: 2.25 };

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
      return <Power size={21} strokeWidth={2.3} />;
    default:
      return <Volume2 {...iconProps} />;
  }
}

function ModeIcon({ mode, kind }: { mode: CycleMode; kind: DeviceKind }) {
  if (mode === "input") {
    return <Mic size={23} strokeWidth={2.25} />;
  }

  return <DeviceIcon kind={kind} />;
}

function AudioMark({ active }: { active: boolean }) {
  return (
    <span className={`audio-mark ${active ? "is-active" : ""}`} aria-hidden="true">
      <span className="audio-disc"><Music2 size={25} strokeWidth={2.35} /></span>
      <span className="audio-bars"><i /><i /><i /><i /><i /></span>
    </span>
  );
}

export default function App() {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [inputDevices, setInputDevices] = useState<AudioDevice[]>([]);
  const [mode, setMode] = useState<CycleMode>("output");
  const [position, setPosition] = useState<WidgetPosition>(() => loadPosition());
  const [monitors, setMonitors] = useState<MonitorBounds[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isHidden, setIsHidden] = useState(false);
  const [isIdle, setIsIdle] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [audioActive, setAudioActive] = useState(false);
  const [toast, setToast] = useState("");
  const dragOffset = useRef({ x: 0, y: 0 });
  const dragStarted = useRef(false);
  const appWindow = useMemo(() => {
    try {
      return getCurrentWindow();
    } catch {
      return null;
    }
  }, []);

  const visibleDevices = mode === "output" ? devices : inputDevices;
  const activeDevice = visibleDevices.find((device) => device.is_default) ?? visibleDevices[0];
  const activeKind = getDeviceKind(activeDevice);
  const dockSide = getDockSide(position, monitors);
  const isAudioPresent = Boolean(activeDevice) && audioActive && !isHidden;

  async function refreshDevices() {
    try {
      const nextDevices = await invoke<AudioDevice[]>("list_audio_outputs");
      setDevices(nextDevices);
      const nextInputDevices = await invoke<AudioDevice[]>("list_audio_inputs");
      setInputDevices(nextInputDevices);
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
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

  useEffect(() => {
    refreshDevices();
    refreshMonitors();

    const poll = window.setInterval(refreshDevices, 5000);
    const activityPoll = window.setInterval(async () => {
      try { setAudioActive(await invoke<boolean>("audio_activity")); } catch { setAudioActive(false); }
    }, 350);
    const monitorPoll = window.setInterval(refreshMonitors, 10000);
    const unlisteners = [
      listen("audio-devices-changed", refreshDevices),
      listen("toggle-widget", () => setIsHidden((current) => !current)),
      listen("open-settings", () => setToast("Startup launch can be toggled from the tray menu.")),
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
    if (switching || isDragging || toast) {
      setIsIdle(false);
      return;
    }

    const timeout = window.setTimeout(() => setIsIdle(true), 2600);
    return () => window.clearTimeout(timeout);
  }, [isDragging, switching, toast, activeDevice?.id, mode]);

  useEffect(() => {
    localStorage.setItem(POSITION_KEY, JSON.stringify(position));
    appWindow?.setPosition(new LogicalPosition(position.x, position.y)).catch(() => undefined);
  }, [appWindow, position]);

  useEffect(() => {
    setPosition((current) => snapToSide(current, monitors));
  }, [monitors]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 1800);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.altKey && event.shiftKey && event.code === "KeyA") {
        setIsHidden((current) => !current);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  function toggleMode() {
    setMode((current) => {
      const next = current === "output" ? "input" : "output";
      setToast(next === "input" ? "Microphone mode" : "Audio output mode");
      return next;
    });
  }

  async function cycleDevice() {
    if (dragStarted.current || switching) return;
    setSwitching(true);

    try {
      const nextDevice = await invoke<AudioDevice>(
        mode === "output" ? "cycle_audio_output" : "cycle_audio_input",
      );
      const updateDevices = (current: AudioDevice[]) =>
        current.map((device) => ({
          ...device,
          is_default: device.id === nextDevice.id,
        }));

      if (mode === "output") {
        setDevices(updateDevices);
      } else {
        setInputDevices(updateDevices);
      }
      setToast(nextDevice.name);
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      window.setTimeout(() => setSwitching(false), 220);
    }
  }

  function startDrag(event: React.PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    dragStarted.current = false;
    dragOffset.current = {
      x: event.screenX - position.x,
      y: event.screenY - position.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDragging(true);
  }

  function moveDrag(event: React.PointerEvent<HTMLButtonElement>) {
    if (!isDragging) return;

    const next = clampPosition(
      {
        x: event.screenX - dragOffset.current.x,
        y: event.screenY - dragOffset.current.y,
      },
      monitors,
    );

    if (Math.abs(next.x - position.x) > 2 || Math.abs(next.y - position.y) > 2) {
      dragStarted.current = true;
    }
    setPosition(next);
  }

  function endDrag(event: React.PointerEvent<HTMLButtonElement>) {
    if (!isDragging) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setIsDragging(false);
    setPosition((current) => snapToSide(current, monitors));
    window.setTimeout(() => {
      dragStarted.current = false;
    }, 0);
  }

  if (isHidden) {
    return (
      <button className="restore-button" onClick={() => setIsHidden(false)} aria-label="Show AudioCycle">
        <Volume2 size={17} />
      </button>
    );
  }

  return (
    <main className={`widget-root dock-${dockSide}`}>
      <button
        className={`widget dock-${dockSide} mode-${mode} kind-${activeKind} ${isDragging ? "dragging" : ""} ${switching ? "switching" : ""} ${isIdle ? "idle" : ""}`}
        aria-label={mode === "output" ? "Cycle audio output" : "Cycle microphone input"}
        title={`${mode === "output" ? "Output" : "Microphone"}: ${
          activeDevice?.name ?? `No active ${mode === "output" ? "audio outputs" : "microphones"}`
        }`}
        onClick={cycleDevice}
        onMouseEnter={() => setIsIdle(false)}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className="edge-wave edge-wave-one" />
        <span className="edge-wave edge-wave-two" />
        <span className="widget-ripple" />
        <span className="device-glyph" key={`${mode}-${activeDevice?.id ?? "empty"}-${activeKind}`}>
          <AudioMark active={isAudioPresent} />
        </span>
        <span className="mode-dot" title={mode === "output" ? "Output" : "Input"} />
      </button>

      <button
        className={`mode-toggle dock-${dockSide} mode-${mode}`}
        aria-label={mode === "output" ? "Switch to microphone mode" : "Switch to audio output mode"}
        title={mode === "output" ? "Switch to microphone" : "Switch to output"}
        onClick={toggleMode}
      >
        <ChevronRight size={14} strokeWidth={2.6} />
      </button>

      <div className="tooltip" role="status">
          <Waves size={12} />
        <span>
          {mode === "output" ? "Output" : "Mic"}:{" "}
          {activeDevice?.name ?? `No active ${mode === "output" ? "audio outputs" : "microphones"}`}
        </span>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}
