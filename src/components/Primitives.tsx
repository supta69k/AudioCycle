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
} from "lucide-react";
import { memo, useMemo } from "react";
import { RING_DOTS } from "../constants/config";
import type { CycleMode, DeviceKind } from "../types/audio";

export const DeviceIcon = memo(function DeviceIcon({
  kind,
  mode,
  muted,
  size = 20,
}: {
  kind: DeviceKind;
  mode: CycleMode;
  muted?: boolean;
  size?: number;
}) {
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
});

/** Dot-matrix ring that doubles as a volume dial, with cached polar coordinates per size. */
export const DotRing = memo(function DotRing({
  size,
  level,
  muted,
  live,
}: {
  size: number;
  level: number;
  muted: boolean;
  live: boolean;
}) {
  const coords = useMemo(() => {
    const c = size / 2;
    const r = c - 5;
    return Array.from({ length: RING_DOTS }, (_, i) => {
      const a = (i / RING_DOTS) * Math.PI * 2 - Math.PI / 2;
      return { cx: c + Math.cos(a) * r, cy: c + Math.sin(a) * r };
    });
  }, [size]);

  const lit = muted ? 0 : Math.round(level * RING_DOTS);

  return (
    <svg
      className={`dot-ring ${live ? "live" : ""}`}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
    >
      {coords.map((pt, i) => (
        <circle
          key={i}
          cx={pt.cx}
          cy={pt.cy}
          r={1.35}
          className={i < lit ? "dot on" : "dot"}
        />
      ))}
    </svg>
  );
});

/**
 * Row of box cells. Filled cells = volume (accent). While audio plays,
 * the cells up to the live signal level light up brighter, so the bar
 * shows both how loud the device is set and what is passing through it.
 */
export const LevelMeter = memo(function LevelMeter({
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
  const sigCells = live
    ? Math.min(volCells, Math.max(1, Math.round(Math.pow(signal, 0.5) * volCells)))
    : 0;
  return (
    <div className={`meter ${live ? "live" : ""} ${muted ? "muted" : ""}`} aria-hidden="true">
      {Array.from({ length: cells }, (_, i) => (
        <i key={i} className={i < sigCells ? "sig" : i < volCells ? "vol" : ""} />
      ))}
    </div>
  );
});

export const Toggle = memo(function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className="row-toggle"
      onClick={() => onChange(!checked)}
    >
      <span>{label}</span>
      <span className={`switch ${checked ? "on" : ""}`}>
        <i />
      </span>
    </button>
  );
});

export function Segmented<T extends string>({
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
