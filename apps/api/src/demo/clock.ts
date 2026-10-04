// The only source of time. Everything uses now(), never Date.now() directly.
// DEMO_MODE compresses time: 1 day = 5 seconds while compression is on.
import { env } from '../env.js';

export const DEMO_RATE = 86_400 / 5; // 1 day = 5 s

let realBase = Date.now();
let virtualBase = realBase;
let rate = 1;
let holdTimer: NodeJS.Timeout | undefined;
let manual = false;

export function nowMs(): number {
  return virtualBase + (Date.now() - realBase) * rate;
}

export function now(): Date {
  return new Date(nowMs());
}

function setRate(next: number): void {
  if (next === rate) return;
  virtualBase = nowMs();
  realBase = Date.now();
  rate = next;
}

/** Never lets virtual time run behind what the database has already seen. */
export function startAt(ms: number): void {
  if (ms > nowMs()) {
    virtualBase = ms;
    realBase = Date.now();
  }
}

/** Step virtual time back to an instant (used when a fired clock needs a human to answer). */
export function rewindTo(ms: number): void {
  if (ms < nowMs()) {
    virtualBase = ms;
    realBase = Date.now();
  }
}

export function isCompressing(): boolean {
  return rate > 1;
}

export function clockInfo() {
  return { now: now().toISOString(), rate, compressing: rate > 1, mode: env.DEMO_MODE ? env.DEMO_CLOCK : 'off', manual };
}

/** Turn compression on or off. Only does anything in DEMO_MODE. */
export function compress(on: boolean): void {
  if (!env.DEMO_MODE || env.DEMO_CLOCK === 'off') return setRate(1);
  if (holdTimer && on) return; // a hold is running; it resumes on its own
  setRate(on ? DEMO_RATE : 1);
}

/** Operator "fast forward" / "pause clock". Keeps compression on until paused. */
export function setManualCompression(on: boolean): void {
  manual = on;
  if (holdTimer) {
    clearTimeout(holdTimer);
    holdTimer = undefined;
  }
  compress(on);
}

export function manualCompression(): boolean {
  return manual || (env.DEMO_MODE && env.DEMO_CLOCK === 'always');
}

/** Run in real time for a while so a human can answer, then resume compression. */
export function holdRealtime(realMs: number, resume: () => boolean): void {
  if (!isCompressing()) return;
  setRate(1);
  if (holdTimer) clearTimeout(holdTimer);
  holdTimer = setTimeout(() => {
    holdTimer = undefined;
    if (resume()) compress(true);
  }, realMs);
  holdTimer.unref?.();
}

export const DAY_MS = 86_400_000;

/** Wall-clock time, for latency budgets only. Never for stored timestamps. */
export const realNowMs = (): number => Date.now();
