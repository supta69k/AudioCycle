import type { CycleMode } from "../types/audio";

let toneCtx: AudioContext | null = null;
let suspendTimer: number | null = null;

export function playTone(mode: CycleMode, enabled: boolean): void {
  if (!enabled) return;
  try {
    toneCtx ??= new AudioContext();
    if (toneCtx.state === "suspended") void toneCtx.resume();
    if (suspendTimer !== null) {
      window.clearTimeout(suspendTimer);
      suspendTimer = null;
    }

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
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
      };
      osc.start(s);
      osc.stop(s + 0.16);
    });

    // Suspend the AudioContext once the chime completes so WebView2 releases its WASAPI stream.
    suspendTimer = window.setTimeout(() => {
      suspendTimer = null;
      if (toneCtx && toneCtx.state === "running") {
        void toneCtx.suspend().catch(() => undefined);
      }
    }, 280);
  } catch {
    // Audio context unavailable.
  }
}
