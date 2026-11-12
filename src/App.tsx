import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LogicalPosition, LogicalSize, getCurrentWindow } from "@tauri-apps/api/window";
import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DeviceIcon, DotRing, LevelMeter, Segmented, Toggle } from "./components/Primitives";
import {
  ACCENTS,
  COMPACT_WINDOW_HEIGHT,
  COMPACT_WINDOW_WIDTH,
  DEFAULT_SETTINGS,
  FALLBACK_INPUTS,
  FALLBACK_MONITOR,
  FALLBACK_OUTPUTS,
  PANEL_WINDOW_HEIGHT,
  PANEL_WINDOW_WIDTH,
  POSITION_KEY,
  SETTINGS_KEY,
  SIZE_MAP,
} from "./constants/config";
import type {
  Accent,
  AppSettings,
  AudioDevice,
  AudioTelemetry,
  ClickAction,
  CycleMode,
  MonitorBounds,
  PanelView,
  RightClickAction,
  WidgetPosition,
} from "./types/audio";
import {
  clampPosition,
  getDeviceKind,
  getDockSide,
  loadPosition,
  loadSettings,
  pad2,
  snapToSide,
} from "./utils/display";
import { playTone } from "./utils/sound";

export type {
  Accent,
  AppSettings,
  ClickAction,
  OrbShape,
  OrbSize,
  RightClickAction,
} from "./types/audio";

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
  const [volumeMode, setVolumeMode] = useState(false);
  const [podHovered, setPodHovered] = useState(false);
  const middleClickTimer = useRef<number | null>(null);
  const hoverLeaveTimer = useRef<number | null>(null);
  const dragRaf = useRef<number | null>(null);
  const pendingPos = useRef<WidgetPosition | null>(null);

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
      const next = await invoke<AudioTelemetry>("get_audio_telemetry", { mode: target });
      setTelemetry((prev) => {
        // Skip React re-render when audio is completely idle and volume/mute haven't moved
        const idleUnchanged =
          !prev.active &&
          !next.active &&
          prev.peak < 0.005 &&
          next.peak < 0.005 &&
          prev.muted === next.muted &&
          Math.abs(prev.volume - next.volume) < 0.002;
        return idleUnchanged ? prev : next;
      });
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
      const next = await invoke<MonitorBounds[]>("list_monitors");
      setMonitors((prev) => {
        if (
          prev.length === next.length &&
          prev.every(
            (m, i) =>
              m.x === next[i].x &&
              m.y === next[i].y &&
              m.width === next[i].width &&
              m.height === next[i].height,
          )
        ) {
          return prev;
        }
        return next;
      });
    } catch {
      setMonitors((prev) => (prev.length ? prev : [FALLBACK_MONITOR]));
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

    const monitorTimer = window.setInterval(refreshMonitors, 20000);
    const unlisteners = [
      listen("audio-devices-changed", () => {
        void refreshDevices();
        void refreshTelemetry();
      }),
      listen("toggle-widget", () => setIsHidden((c) => !c)),
      listen("show-widget", () => setIsHidden(false)),
      listen("cycle-active-shortcut", () => void cycleTargetMode(modeRef.current)),
      listen("open-settings", () => {
        setIsHidden(false);
        toggleControlPanel(true);
      }),
    ];
    return () => {
      window.clearInterval(monitorTimer);
      unlisteners.forEach((p) => p.then((u) => u()).catch(() => undefined));
    };
  }, []);

  // Dynamic telemetry polling:
  // - 100ms when panel is open (responsive VU meter ballistics)
  // - 160ms when active/live, hovered, or in volume mode
  // - 400ms when idle & silent (saves CPU and battery for laptops)
  // - Paused completely when hidden (0% CPU)
  useEffect(() => {
    if (isHidden) return;
    void refreshTelemetry();
    const interval = panelOpen ? 100 : (!isIdle || liveHold || volumeMode) ? 160 : 400;
    const telemetryTimer = window.setInterval(
      () => void refreshTelemetry(),
      interval,
    );
    return () => window.clearInterval(telemetryTimer);
  }, [panelOpen, isHidden, isIdle, liveHold, volumeMode]);

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

  // Meter ballistics: fast attack, slow release (only calculated when control panel is open).
  useEffect(() => {
    if (!panelOpen) return;
    const target = telemetry.muted ? 0 : Math.max(telemetry.peak_l, telemetry.peak_r, telemetry.peak);
    setMeterLevel((prev) => {
      const next = target >= prev ? target : prev * 0.72 + target * 0.28;
      return next < 0.004 ? 0 : next;
    });
  }, [telemetry, panelOpen]);

  useEffect(() => {
    if (!settings.idleAutoDim || panelOpen || switching || isDragging || toast || volumeMode || podHovered) {
      setIsIdle(false);
      return;
    }
    const t = window.setTimeout(() => setIsIdle(true), 2600);
    return () => window.clearTimeout(t);
  }, [settings.idleAutoDim, panelOpen, isDragging, switching, toast, volumeMode, podHovered, activeDevice?.id, mode]);

  useEffect(() => {
    if (isDragging) return;
    localStorage.setItem(POSITION_KEY, JSON.stringify(position));
    appWindow?.setPosition(new LogicalPosition(position.x, position.y)).catch(() => undefined);
  }, [appWindow, position, isDragging]);

  useEffect(() => {
    if (!panelOpen && monitors.length > 0) {
      setPosition((c) => snapToSide(c, monitors, settings.snapToEdges));
    }
  }, [monitors, settings.snapToEdges]);

  // Volume mode only makes sense on the floating pod.
  useEffect(() => {
    if (panelOpen || isHidden) {
      setVolumeMode(false);
      setPodHovered(false);
    }
  }, [panelOpen, isHidden]);

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
      else if (e.key === "Escape" && volumeMode) setVolumeMode(false);
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
      const updated = await invoke<AudioDevice>(
        target === "output" ? "set_audio_output" : "set_audio_input",
        { id },
      );
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
      const next = await invoke<AudioDevice>(
        target === "output" ? "cycle_audio_output" : "cycle_audio_input",
      );
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

    // While muted, a plain click on the pod just unmutes (no device cycling).
    if (telemetry.muted && settings.clickAction !== "open-panel") {
      await handleToggleMute();
      return;
    }

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

  /**
   * Scroll-wheel volume.
   * Only active in volume mode (single middle-click); scrolling anywhere over the widget changes volume.
   */
  function handleWheel(e: React.WheelEvent) {
    if (!volumeMode) return;
    const next = Math.min(1, Math.max(0, telemetry.volume + (e.deltaY < 0 ? 0.04 : -0.04)));
    void handleVolumeChange(next);
  }

  function toggleVolumeMode() {
    const next = !volumeMode;
    setVolumeMode(next);
    notify(next ? "Volume mode · scroll" : "Volume mode off");
    playTone(modeRef.current, settings.switchTone);
  }

  /**
   * Middle mouse button (scroll-wheel click):
   * - single click  → enter / leave volume mode (fires after a short wait so a double click can be told apart)
   * - double click  → mute / unmute
   */
  function handleAuxClick(e: React.MouseEvent) {
    if (e.button !== 1) return;
    e.preventDefault();

    if (middleClickTimer.current !== null) {
      window.clearTimeout(middleClickTimer.current);
      middleClickTimer.current = null;
      void handleToggleMute();
      return;
    }

    middleClickTimer.current = window.setTimeout(() => {
      middleClickTimer.current = null;
      toggleVolumeMode();
    }, 260);
  }

  // Stop the browser's middle-click auto-scroll cursor from hijacking the click.
  function handlePodMouseDown(e: React.MouseEvent) {
    if (e.button === 1) e.preventDefault();
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
    if (
      e.currentTarget.tagName !== "BUTTON" &&
      (e.target as HTMLElement).closest("button, input, select, a")
    ) {
      return;
    }
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
    if (Math.abs(next.x - position.x) > 2 || Math.abs(next.y - position.y) > 2) {
      dragStarted.current = true;
    }
    pendingPos.current = next;

    if (dragRaf.current === null) {
      dragRaf.current = requestAnimationFrame(() => {
        dragRaf.current = null;
        if (pendingPos.current) {
          const target = pendingPos.current;
          setPosition(target);
          appWindow?.setPosition(new LogicalPosition(target.x, target.y)).catch(() => undefined);
        }
      });
    }
  }

  function endDrag(e: React.PointerEvent<HTMLElement>) {
    if (!isDragging) return;
    if (dragRaf.current !== null) {
      cancelAnimationFrame(dragRaf.current);
      dragRaf.current = null;
    }
    e.currentTarget.releasePointerCapture(e.pointerId);
    setIsDragging(false);

    const target = pendingPos.current ?? position;
    const finalPos = !panelOpen ? snapToSide(target, monitors, settings.snapToEdges) : target;
    pendingPos.current = null;
    setPosition(finalPos);
    localStorage.setItem(POSITION_KEY, JSON.stringify(finalPos));
    appWindow?.setPosition(new LogicalPosition(finalPos.x, finalPos.y)).catch(() => undefined);

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
        <header
          className="panel-head"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
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
            <button
              type="button"
              className={`mute ${telemetry.muted ? "on" : ""}`}
              onClick={handleToggleMute}
            >
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
          <button
            role="tab"
            aria-selected={panelView === "devices"}
            className={panelView === "devices" ? "active" : ""}
            onClick={() => setPanelView("devices")}
          >
            Devices <sup>{pad2(visibleDevices.length)}</sup>
          </button>
          <button
            role="tab"
            aria-selected={panelView === "settings"}
            className={panelView === "settings" ? "active" : ""}
            onClick={() => setPanelView("settings")}
          >
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
                    <li
                      key={d.id}
                      className={`device ${d.is_default ? "active" : ""} ${excluded ? "skipped" : ""}`}
                    >
                      <button
                        className="device-main"
                        onClick={() => void selectSpecificDevice(mode, d.id)}
                        title={`Switch to ${d.name}`}
                      >
                        <span className="idx">{pad2(i + 1)}</span>
                        <span className="device-name">{d.name}</span>
                        {d.is_default && <span className="badge">Active</span>}
                      </button>
                      <button
                        className={`loop ${excluded ? "" : "on"}`}
                        onClick={() => toggleDeviceExclusion(d.id)}
                        title={
                          excluded
                            ? "Skipped when cycling. Click to include"
                            : "Included when cycling. Click to skip"
                        }
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
                  <select
                    className="select"
                    value={settings.clickAction}
                    onChange={(e) => updateSetting("clickAction", e.target.value as ClickAction)}
                  >
                    <option value="cycle-current">Cycle current</option>
                    <option value="cycle-output">Cycle outputs</option>
                    <option value="cycle-input">Cycle inputs</option>
                    <option value="open-panel">Open panel</option>
                  </select>
                </div>
                <div className="field stacked">
                  <span>Right click</span>
                  <select
                    className="select"
                    value={settings.rightClickAction}
                    onChange={(e) =>
                      updateSetting("rightClickAction", e.target.value as RightClickAction)
                    }
                  >
                    <option value="open-panel">Open panel</option>
                    <option value="toggle-mode">Flip output / input</option>
                    <option value="hide-widget">Hide</option>
                  </select>
                </div>
                <Toggle
                  label="Switch tone"
                  checked={settings.switchTone}
                  onChange={(v) => updateSetting("switchTone", v)}
                />
                <Toggle
                  label="Snap to screen edge"
                  checked={settings.snapToEdges}
                  onChange={(v) => updateSetting("snapToEdges", v)}
                />
                <Toggle
                  label="Fade when idle"
                  checked={settings.idleAutoDim}
                  onChange={(v) => updateSetting("idleAutoDim", v)}
                />
                <Toggle
                  label="Side buttons"
                  checked={settings.showQuickControls}
                  onChange={(v) => updateSetting("showQuickControls", v)}
                />
                <Toggle
                  label="Hover tooltip"
                  checked={settings.showTooltip}
                  onChange={(v) => updateSetting("showTooltip", v)}
                />
                <Toggle
                  label="Switch notification"
                  checked={settings.showToast}
                  onChange={(v) => updateSetting("showToast", v)}
                />
                <Toggle
                  label="Launch at startup"
                  checked={autostart}
                  onChange={() => void toggleAutostart()}
                />
              </section>

              <section className="shortcuts">
                <h3 className="label">Shortcuts</h3>
                <dl>
                  <dt>Cycle device</dt>
                  <dd>
                    <kbd>Alt</kbd>
                    <kbd>Shift</kbd>
                    <kbd>C</kbd>
                  </dd>
                  <dt>Show / hide</dt>
                  <dd>
                    <kbd>Alt</kbd>
                    <kbd>Shift</kbd>
                    <kbd>A</kbd>
                  </dd>
                  <dt>Open panel</dt>
                  <dd>
                    <kbd>Alt</kbd>
                    <kbd>Shift</kbd>
                    <kbd>S</kbd>
                  </dd>
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

  function enterPod() {
    if (hoverLeaveTimer.current !== null) {
      window.clearTimeout(hoverLeaveTimer.current);
      hoverLeaveTimer.current = null;
    }
    setPodHovered(true);
    setIsIdle(false);
  }

  function leavePod() {
    if (hoverLeaveTimer.current !== null) {
      window.clearTimeout(hoverLeaveTimer.current);
    }
    hoverLeaveTimer.current = window.setTimeout(() => {
      hoverLeaveTimer.current = null;
      setPodHovered(false);
    }, 140);
  }

  return (
    <main className={`widget-root dock-${dockSide} ${podHovered ? "pod-active" : ""}`} style={cssVars}>
      <button
        className={`pod shape-${settings.orbShape} ${isDragging ? "dragging" : ""} ${switching ? "switching" : ""} ${isIdle ? "idle" : ""} ${live ? "live" : ""} ${mode === "input" ? "is-input" : ""} ${volumeMode ? "vol-mode" : ""}`}
        aria-label={mode === "output" ? "Cycle audio output" : "Cycle microphone"}
        onClick={handlePrimaryClick}
        onWheel={handleWheel}
        onAuxClick={handleAuxClick}
        onMouseDown={handlePodMouseDown}
        onContextMenu={handleContextMenu}
        onMouseEnter={enterPod}
        onPointerEnter={enterPod}
        onMouseMove={enterPod}
        onMouseLeave={leavePod}
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

      {volumeMode && (
        <div className="mode-tag" role="status" aria-live="polite">
          <span>VOL</span>
          <b>{pad2(volumePct)}</b>
        </div>
      )}

      {settings.showQuickControls && !volumeMode && (
        <div
          className="side-controls"
          onMouseEnter={() => {
            if (podHovered) enterPod();
          }}
          onMouseMove={() => {
            if (podHovered) enterPod();
          }}
          onMouseLeave={leavePod}
        >
          <button
            onClick={toggleMode}
            title={mode === "output" ? "Switch to input" : "Switch to output"}
            aria-label="Flip output / input"
          >
            {mode === "output" ? "OUT" : "IN"}
          </button>
          <button
            onClick={() => toggleControlPanel(true)}
            title="Open panel (Alt+Shift+S)"
            aria-label="Open panel"
          >
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
