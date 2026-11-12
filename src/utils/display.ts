import {
  COMPACT_WINDOW_HEIGHT,
  COMPACT_WINDOW_WIDTH,
  DEFAULT_SETTINGS,
  FALLBACK_MONITOR,
  POSITION_KEY,
  SETTINGS_KEY,
  SNAP_MARGIN,
} from "../constants/config";
import type { AppSettings, AudioDevice, DeviceKind, DockSide, MonitorBounds, WidgetPosition } from "../types/audio";

export function loadPosition(): WidgetPosition {
  try {
    const saved = localStorage.getItem(POSITION_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as WidgetPosition;
      if (
        parsed &&
        typeof parsed.x === "number" &&
        typeof parsed.y === "number" &&
        Number.isFinite(parsed.x) &&
        Number.isFinite(parsed.y)
      ) {
        return parsed;
      }
    }
  } catch {
    // default
  }
  return { x: 18, y: 180 };
}

export function loadSettings(): AppSettings {
  try {
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (saved) return { ...DEFAULT_SETTINGS, ...(JSON.parse(saved) as Partial<AppSettings>) };
  } catch {
    // defaults
  }
  return DEFAULT_SETTINGS;
}

export function getNearestMonitor(
  point: WidgetPosition,
  monitors: MonitorBounds[],
  orbPixels = 60,
): MonitorBounds {
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

export function clampPosition(
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

export function snapToSide(
  point: WidgetPosition,
  monitors: MonitorBounds[],
  snapEnabled: boolean,
): WidgetPosition {
  const clamped = clampPosition(point, monitors);
  if (!snapEnabled) return clamped;
  const m = getNearestMonitor(clamped, monitors);
  const centerX = clamped.x + COMPACT_WINDOW_WIDTH / 2;
  return {
    ...clamped,
    x: centerX < m.x + m.width / 2 ? m.x : m.x + m.width - COMPACT_WINDOW_WIDTH,
  };
}

export function getDockSide(
  position: WidgetPosition,
  monitors: MonitorBounds[],
  orbPixels: number,
): DockSide {
  const m = getNearestMonitor(position, monitors, orbPixels);
  return position.x + orbPixels / 2 < m.x + m.width / 2 ? "left" : "right";
}

export function getDeviceKind(device?: AudioDevice): DeviceKind {
  if (!device) return "empty";
  const n = device.name.toLowerCase();
  if (n.includes("bluetooth") || n.includes("bt ") || n.includes("airpods")) return "bluetooth";
  if (n.includes("headphone") || n.includes("headset") || n.includes("earbud")) return "headphones";
  if (n.includes("monitor") || n.includes("display") || n.includes("hdmi") || n.includes("nvidia")) {
    return "monitor";
  }
  if (n.includes("speaker") || n.includes("realtek")) return "speaker";
  return "default";
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
