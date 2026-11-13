import { X } from "lucide-react";
import { Fragment, useState, type CSSProperties, type PointerEvent } from "react";
import { ACCENTS } from "../constants/config";
import type {
  Accent,
  AppSettings,
  AudioDevice,
  AudioTelemetry,
  ClickAction,
  CycleMode,
  PanelView,
  RightClickAction,
} from "../types/audio";
import { pad2 } from "../utils/display";
import { LevelMeter, Segmented, Toggle } from "./Primitives";

export interface ControlPanelProps {
  mode: CycleMode;
  onModeChange: (mode: CycleMode) => void;
  devices: AudioDevice[];
  activeDevice?: AudioDevice;
  telemetry: AudioTelemetry;
  meterLevel: number;
  live: boolean;
  volumePct: number;
  settings: AppSettings;
  autostart: boolean;
  cssVars: CSSProperties;
  onDragStart: (e: PointerEvent<HTMLElement>) => void;
  onDragMove: (e: PointerEvent<HTMLElement>) => void;
  onDragEnd: (e: PointerEvent<HTMLElement>) => void;
  onClose: () => void;
  onVolumeChange: (level: number) => void;
  onToggleMute: () => void;
  onSelectDevice: (id: string) => void;
  onToggleExclusion: (id: string) => void;
  onUpdateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  onToggleAutostart: () => void;
  onResetDefaults: () => void;
}

const APPEARANCE_SHAPES = [
  { id: "circle" as const, label: "Round" },
  { id: "squircle" as const, label: "Soft" },
  { id: "square" as const, label: "Square" },
];

const APPEARANCE_SIZES = [
  { id: "compact" as const, label: "S" },
  { id: "normal" as const, label: "M" },
  { id: "large" as const, label: "L" },
];

const SHORTCUT_ITEMS: Array<[string, string[]]> = [
  ["Cycle device", ["Alt", "Shift", "C"]],
  ["Show / hide", ["Alt", "Shift", "A"]],
  ["Open panel", ["Alt", "Shift", "S"]],
];

/** Expanded studio control panel for device routing, stereo VU telemetry, and settings. */
export function ControlPanel({
  mode,
  onModeChange,
  devices,
  activeDevice,
  telemetry,
  meterLevel,
  live,
  volumePct,
  settings,
  autostart,
  cssVars,
  onDragStart,
  onDragMove,
  onDragEnd,
  onClose,
  onVolumeChange,
  onToggleMute,
  onSelectDevice,
  onToggleExclusion,
  onUpdateSetting,
  onToggleAutostart,
  onResetDefaults,
}: ControlPanelProps) {
  const [panelView, setPanelView] = useState<PanelView>("devices");
  const statusLabel = telemetry.muted
    ? "Muted"
    : live
      ? mode === "output"
        ? "Playing"
        : "Hearing"
      : "Silent";

  return (
    <section className="panel" style={cssVars}>
      <header
        className="panel-head"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
      >
        <div className="brand">
          <span className={`status-dot ${live ? "live" : ""}`} />
          <span className="label">AudioCycle</span>
        </div>
        <Segmented
          value={mode}
          onChange={onModeChange}
          options={[
            { id: "output", label: "Out" },
            { id: "input", label: "In" },
          ]}
        />
        <button
          type="button"
          className="icon-btn"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onClose}
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
            {statusLabel}
          </span>
          <button
            type="button"
            className={`mute ${telemetry.muted ? "on" : ""}`}
            onClick={onToggleMute}
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
          onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
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
          Devices <sup>{pad2(devices.length)}</sup>
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
              {devices.map((d, i) => {
                const excluded = settings.excludedDeviceIds.includes(d.id);
                return (
                  <li
                    key={d.id}
                    className={`device ${d.is_default ? "active" : ""} ${excluded ? "skipped" : ""}`}
                  >
                    <button
                      className="device-main"
                      onClick={() => onSelectDevice(d.id)}
                      title={`Switch to ${d.name}`}
                    >
                      <span className="idx">{pad2(i + 1)}</span>
                      <span className="device-name">{d.name}</span>
                      {d.is_default && <span className="badge">Active</span>}
                    </button>
                    <button
                      className={`loop ${excluded ? "" : "on"}`}
                      onClick={() => onToggleExclusion(d.id)}
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
              {devices.length === 0 && <li className="empty">No {mode} devices found</li>}
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
                      onClick={() => onUpdateSetting("accent", a)}
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
                  onChange={(v) => onUpdateSetting("orbShape", v)}
                  options={APPEARANCE_SHAPES}
                />
              </div>
              <div className="field">
                <span>Size</span>
                <Segmented
                  value={settings.orbSize}
                  onChange={(v) => onUpdateSetting("orbSize", v)}
                  options={APPEARANCE_SIZES}
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
                  onChange={(e) => onUpdateSetting("clickAction", e.target.value as ClickAction)}
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
                    onUpdateSetting("rightClickAction", e.target.value as RightClickAction)
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
                onChange={(v) => onUpdateSetting("switchTone", v)}
              />
              <Toggle
                label="Snap to screen edge"
                checked={settings.snapToEdges}
                onChange={(v) => onUpdateSetting("snapToEdges", v)}
              />
              <Toggle
                label="Fade when idle"
                checked={settings.idleAutoDim}
                onChange={(v) => onUpdateSetting("idleAutoDim", v)}
              />
              <Toggle
                label="Side buttons"
                checked={settings.showQuickControls}
                onChange={(v) => onUpdateSetting("showQuickControls", v)}
              />
              <Toggle
                label="Hover tooltip"
                checked={settings.showTooltip}
                onChange={(v) => onUpdateSetting("showTooltip", v)}
              />
              <Toggle
                label="Switch notification"
                checked={settings.showToast}
                onChange={(v) => onUpdateSetting("showToast", v)}
              />
              <Toggle
                label="Launch at startup"
                checked={autostart}
                onChange={onToggleAutostart}
              />
            </section>

            <section className="shortcuts">
              <h3 className="label">Shortcuts</h3>
              <dl>
                {SHORTCUT_ITEMS.map(([label, keys]) => (
                  <Fragment key={label}>
                    <dt>{label}</dt>
                    <dd>
                      {keys.map((key) => (
                        <kbd key={key}>{key}</kbd>
                      ))}
                    </dd>
                  </Fragment>
                ))}
              </dl>
            </section>

            <button className="reset" onClick={onResetDefaults}>
              Reset to defaults
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
