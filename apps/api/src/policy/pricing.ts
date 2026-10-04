// Ask, floor and decay math. Pure functions, amounts in cents.

export const ASK_MULTIPLIER = 1.1;
export const FLOOR_MULTIPLIER = 0.75;
export const MIN_COMPS = 3;

/** Round to the nearest $5. */
export function roundTo5(cents: number): number {
  return Math.round(cents / 500) * 500;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Discard comps outside 0.4x to 2.5x of the median. */
export function discardOutliers(prices: number[]): number[] {
  const m = median(prices);
  if (m <= 0) return [];
  return prices.filter((p) => p >= 0.4 * m && p <= 2.5 * m);
}

export type PriceProposal =
  | { ok: true; askCents: number; floorCents: number; medianCents: number; loCents: number; hiCents: number; n: number }
  | { ok: false; reason: 'too_few_comps'; n: number };

/**
 * Ask = round_to_5(median * 1.10). Floor = round_to_5(median * 0.75) unless overridden.
 * Fewer than 3 usable comps: no price is invented, the caller asks Henri.
 */
export function proposePrice(compPricesCents: number[], floorOverrideCents?: number): PriceProposal {
  const kept = discardOutliers(compPricesCents.filter((p) => Number.isFinite(p) && p > 0));
  if (kept.length < MIN_COMPS) return { ok: false, reason: 'too_few_comps', n: kept.length };
  const m = median(kept);
  const askCents = roundTo5(m * ASK_MULTIPLIER);
  let floorCents = floorOverrideCents ?? roundTo5(m * FLOOR_MULTIPLIER);
  if (floorCents > askCents) floorCents = askCents;
  return { ok: true, askCents, floorCents, medianCents: Math.round(m), loCents: Math.min(...kept), hiCents: Math.max(...kept), n: kept.length };
}

export interface DecayParams {
  askCents: number;
  floorCents: number;
  decayPct: number;
  decayEveryDays: number;
}

/** Price at day d: max(floor, ask * (1 - decay_pct/100) ^ floor(d / decay_every_days)), rounded to 5. */
export function priceAtDay(p: DecayParams, daysListed: number): number {
  const steps = p.decayEveryDays > 0 ? Math.floor(Math.max(0, daysListed) / p.decayEveryDays) : 0;
  const decayed = roundTo5(p.askCents * Math.pow(1 - p.decayPct / 100, steps));
  return Math.max(p.floorCents, decayed);
}

/** One decay step applied by the scheduler to the current ask. Never goes below the floor. */
export function decayStep(currentAskCents: number, floorCents: number, decayPct: number): number {
  return Math.max(floorCents, roundTo5(currentAskCents * (1 - decayPct / 100)));
}

/** "floor 150" or "floor $150" in a photo caption sets the floor. */
export function parseFloorFromCaption(caption?: string | null): number | undefined {
  if (!caption) return undefined;
  const m = caption.match(/\bfloor\s*:?\s*\$?\s*(\d{1,6})(?:\.(\d{2}))?\b/i);
  if (!m) return undefined;
  return parseInt(m[1]!, 10) * 100 + (m[2] ? parseInt(m[2], 10) : 0);
}

/** "ask 220" or "price 220" in a caption or a Change price reply. */
export function parseAskFromText(text?: string | null): number | undefined {
  if (!text) return undefined;
  const m = text.match(/\b(?:ask|price|asking)\s*:?\s*\$?\s*(\d{1,6})\b/i) ?? text.match(/^\s*\$?\s*(\d{1,6})\s*$/);
  if (!m) return undefined;
  return parseInt(m[1]!, 10) * 100;
}

export function dollars(cents: number | null | undefined): string {
  if (cents == null) return '$?';
  const d = cents / 100;
  return Number.isInteger(d) ? `$${d}` : `$${d.toFixed(2)}`;
}
