// Buyer score. Pure.
// score = 0.6 * min(offer / current_ask, 1.1) + 0.4 * reliability
// reliability = 0.4 * has_concrete_time + 0.3 * replied_within_30_min + 0.3 * no_scam_flags

export interface ScoreInput {
  offerCents?: number | null;
  currentAskCents: number;
  hasConcreteTime: boolean;
  repliedWithin30Min: boolean;
  noScamFlags: boolean;
}

export function reliability(i: Pick<ScoreInput, 'hasConcreteTime' | 'repliedWithin30Min' | 'noScamFlags'>): number {
  return 0.4 * (i.hasConcreteTime ? 1 : 0) + 0.3 * (i.repliedWithin30Min ? 1 : 0) + 0.3 * (i.noScamFlags ? 1 : 0);
}

export function buyerScore(i: ScoreInput): number {
  const ratio = i.offerCents != null && i.currentAskCents > 0 ? Math.min(i.offerCents / i.currentAskCents, 1.1) : 0;
  const s = 0.6 * ratio + 0.4 * reliability(i);
  return Math.round(s * 1000) / 1000;
}
