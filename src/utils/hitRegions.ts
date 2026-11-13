import type { DockSide, OrbShape } from "../types/audio";

export type HitRegion =
  | { kind: "circle"; cx: number; cy: number; r: number }
  | { kind: "roundrect"; x: number; y: number; w: number; h: number; r: number }
  | { kind: "rect"; x: number; y: number; w: number; h: number };

export interface HitConfig {
  capture_all: boolean;
  regions: HitRegion[];
}

export interface HitRegionParams {
  panelOpen: boolean;
  isDragging: boolean;
  isHidden: boolean;
  podHovered: boolean;
  isIdle: boolean;
  volumeMode: boolean;
  showQuickControls: boolean;
  orbShape: OrbShape;
  dockSide: DockSide;
  podEl: HTMLElement | null;
  sideControlsEl: HTMLElement | null;
  modeTagEl: HTMLElement | null;
  restoreEl: HTMLElement | null;
}

interface LayoutBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Resolve an element's un-transformed layout box in window-logical coordinates. */
function getLayoutBox(el: HTMLElement): LayoutBox {
  let x = 0;
  let y = 0;
  let cur: HTMLElement | null = el;
  while (cur) {
    x += cur.offsetLeft;
    y += cur.offsetTop;
    cur = cur.offsetParent as HTMLElement | null;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

function buildPodRegion(
  box: LayoutBox,
  podEl: HTMLElement,
  orbShape: OrbShape,
  scale: number,
  shiftX: number,
): HitRegion {
  const cx = box.x + box.w / 2 + shiftX;
  const cy = box.y + box.h / 2;
  const visW = box.w * scale;
  const visH = box.h * scale;

  if (orbShape === "circle") {
    return { kind: "circle", cx, cy, r: visW / 2 + 0.5 };
  }

  const rawRadius = Number.parseFloat(getComputedStyle(podEl).borderTopLeftRadius) || 0;
  return {
    kind: "roundrect",
    x: cx - visW / 2 - 0.5,
    y: cy - visH / 2 - 0.5,
    w: visW + 1,
    h: visH + 1,
    r: rawRadius * scale + 0.5,
  };
}

function buildPodEdgeBridge(
  box: LayoutBox,
  scale: number,
  dockSide: DockSide,
): HitRegion {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const visW = box.w * scale;
  const visH = box.h * scale;
  const reach = 18 * scale;

  if (dockSide === "left") {
    return {
      kind: "rect",
      x: cx - visW / 2 - reach,
      y: cy - visH / 2,
      w: visW / 2 + reach,
      h: visH,
    };
  }

  return {
    kind: "rect",
    x: cx,
    y: cy - visH / 2,
    w: visW / 2 + reach,
    h: visH,
  };
}

/** Build exact interactive hit regions so empty transparent padding passes clicks through. */
export function buildHitConfig(params: HitRegionParams): HitConfig {
  if (params.panelOpen || params.isDragging) {
    return { capture_all: true, regions: [] };
  }

  if (params.isHidden) {
    if (!params.restoreEl) {
      return { capture_all: false, regions: [] };
    }
    const box = getLayoutBox(params.restoreEl);
    return {
      capture_all: false,
      regions: [
        {
          kind: "circle",
          cx: box.x + box.w / 2,
          cy: box.y + box.h / 2,
          r: box.w / 2 + 0.5,
        },
      ],
    };
  }

  const regions: HitRegion[] = [];

  if (params.podEl) {
    const scale = params.podHovered ? 1.04 : params.isIdle ? 0.88 : 1;
    const shiftX =
      params.podHovered || !params.isIdle
        ? 0
        : params.dockSide === "right"
          ? 16
          : -16;
    const podBox = getLayoutBox(params.podEl);
    regions.push(buildPodRegion(podBox, params.podEl, params.orbShape, scale, shiftX));

    if (params.podHovered) {
      regions.push(buildPodEdgeBridge(podBox, scale, params.dockSide));
    }
  }

  if (params.podHovered && params.showQuickControls && !params.volumeMode && params.sideControlsEl) {
    const ctrl = getLayoutBox(params.sideControlsEl);
    regions.push({ kind: "roundrect", x: ctrl.x, y: ctrl.y, w: ctrl.w, h: ctrl.h, r: 4 });
    regions.push({
      kind: "rect",
      x: params.dockSide === "left" ? ctrl.x - 10 : ctrl.x + ctrl.w - 2,
      y: ctrl.y,
      w: 12,
      h: ctrl.h,
    });
  }

  if (params.volumeMode && params.modeTagEl) {
    const tag = getLayoutBox(params.modeTagEl);
    regions.push({ kind: "roundrect", x: tag.x, y: tag.y, w: tag.w, h: tag.h, r: 4 });
  }

  return { capture_all: false, regions };
}
