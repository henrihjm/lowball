// Negotiation rules. The model writes the words. Code decides the numbers.
// Pure functions, amounts in cents.

import { dollars, roundTo5 } from './pricing.js';

export const MAX_COUNTERS = 2;
export const OUTBOUND_COOLDOWN_MS = 10 * 60 * 1000;
export const MAX_REGENERATIONS = 2;

// ---------- reading buyer text ----------

const DOLLAR_RE = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?!\d)/g;
const SUFFIX_RE = /(?<![\d.$])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(?:bucks?|dollars?|usd|cash)\b/gi;
const BARE_RE = /(?<![\d.$:#/-])(\d{2,4})(?![\d:%/-])/g;
const TIME_BEFORE_RE = /\b(?:at|by|around|before|after|until|till|from|to|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|tonight|morning|evening|afternoon)\s*,?\s*$/i;
const UNIT_AFTER_RE = /^\s*(?:am|pm|a\.m|p\.m|o'?clock|min|mins|minutes|hours?|hrs?|miles?|mi\b|days?|weeks?|years?|inch|in\b|cm|lbs?|kg|st\b|street|ave|blvd|th\b|nd\b|rd\b)/i;

function toCents(whole: string, frac?: string): number {
  const w = parseInt(whole.replace(/,/g, ''), 10);
  const f = frac ? parseInt(frac.padEnd(2, '0'), 10) : 0;
  return w * 100 + f;
}

/** All explicit dollar amounts in a text: "$80", "80 bucks", "80 cash", "80 dollars". */
export function extractDollarAmounts(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(DOLLAR_RE)) out.push(toCents(m[1]!, m[2]));
  for (const m of text.matchAll(SUFFIX_RE)) out.push(toCents(m[1]!, m[2]));
  return out;
}

/** Bare numbers that read like prices ("120 final", "ok 180"), excluding times, years and units. */
export function extractBareAmounts(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(BARE_RE)) {
    const n = parseInt(m[1]!, 10);
    const before = text.slice(0, m.index);
    const after = text.slice(m.index! + m[0].length);
    if (TIME_BEFORE_RE.test(before)) continue;
    if (UNIT_AFTER_RE.test(after)) continue;
    if (m[1]!.length === 4 && n >= 1900 && n <= 2100) continue;
    out.push(n * 100);
  }
  return out;
}

const FULL_PRICE_RE = /\b(?:full|asking|your|listed|list)\s+price\b|\bpay\s+(?:what\s+you(?:'re| are)\s+asking|asking)\b/i;

export interface OfferExtraction {
  offerCents?: number;
  candidates: number[];
}

/**
 * The buyer's offer, if any. Explicit dollar amounts win over bare numbers.
 * "full price" means the current ask. With several candidates, the last one that
 * is not simply the ask repeated is taken, unless a hint (from the classifier)
 * names one of the candidates.
 */
export function extractOfferCents(text: string, currentAskCents?: number | null, hintCents?: number | null): OfferExtraction {
  let candidates = extractDollarAmounts(text);
  if (candidates.length === 0) candidates = extractBareAmounts(text);
  if (candidates.length === 0) {
    if (currentAskCents != null && FULL_PRICE_RE.test(text)) return { offerCents: currentAskCents, candidates: [currentAskCents] };
    return { candidates: [] };
  }
  if (hintCents != null && candidates.includes(hintCents)) return { offerCents: hintCents, candidates };
  const notAsk = candidates.filter((c) => c !== currentAskCents);
  const pool = notAsk.length > 0 ? notAsk : candidates;
  return { offerCents: pool[pool.length - 1], candidates };
}

const INJECTION_RES: RegExp[] = [
  /\bignore\s+(?:all\s+|any\s+)?(?:of\s+)?(?:your\s+|the\s+|my\s+|these\s+|those\s+)?(?:previous\s+|prior\s+|above\s+|earlier\s+|all\s+|other\s+)*(?:instructions?|rules?|prompts?|guidelines?|directions?|constraints?|limits?)/i,
  /\bdisregard\s+(?:all|any|your|the|previous|prior|everything)\b/i,
  /\bforget\s+(?:everything|all|your|the|previous|prior)\b/i,
  /\b(?:system|developer|admin)\s*(?:prompt|message|override|mode|note|instruction)s?\b/i,
  /\byou\s+are\s+now\b/i,
  /\bnew\s+(?:instructions?|rules?|directive)\b/i,
  /\boverride\s+(?:your|the|all|any)\b/i,
  /\b(?:i\s+am|i'm|this\s+is)\s+(?:henri|the\s+seller|the\s+owner|your\s+(?:owner|creator|developer|boss|admin|operator|user))\b/i,
  /\b(?:jailbreak|dan\s+mode|prompt\s+injection)\b/i,
  /\b(?:reveal|tell\s+me|what(?:'s| is))\s+(?:your|the)\s+(?:floor|lowest|minimum|reserve|system\s+prompt|instructions)\b/i,
  /<\/?(?:system|instructions?|assistant)>/i,
];

/** Buyer text that tries to instruct the agent. It is still treated as text. */
export function detectInjection(text: string): boolean {
  return INJECTION_RES.some((re) => re.test(text));
}

// ---------- deciding the numbers ----------

export interface NegotiationFacts {
  currentAskCents: number;
  floorCents: number;
  offerCents?: number | null;
  countersUsed: number;
  lastCounterCents?: number | null;
  agreedCents?: number | null;
  bestOtherOfferCents?: number | null;
  /** A below_floor decision for this buyer resolved with take_it. */
  belowFloorApproved?: boolean;
}

export type Decision =
  | { action: 'answer'; priceCents: number; final: false }
  | { action: 'counter'; priceCents: number; final: boolean }
  | { action: 'accept_conditional'; priceCents: number; final: false }
  | { action: 'match_higher'; priceCents: number; final: false };

/**
 * Counter rule:
 * - offer < floor: counter = max(floor, round_to_5((ask + offer) / 2)), never above our own last counter.
 *   After MAX_COUNTERS counters the counter is the floor and the message is final.
 * - offer >= floor and offer >= best_other * 0.95: accept, conditional on a pickup slot.
 * - offer >= floor but clearly below best_other: ask the buyer to match the higher offer.
 * - no offer: state the standing price.
 */
export function decide(f: NegotiationFacts): Decision {
  const standing = Math.max(f.floorCents, f.agreedCents ?? f.lastCounterCents ?? f.currentAskCents);
  if (f.offerCents == null) return { action: 'answer', priceCents: standing, final: false };

  const offer = f.offerCents;
  if (offer < f.floorCents) {
    if (f.belowFloorApproved) return { action: 'accept_conditional', priceCents: offer, final: false };
    if (f.countersUsed >= MAX_COUNTERS) return { action: 'counter', priceCents: f.floorCents, final: true };
    let counter = Math.max(f.floorCents, roundTo5((f.currentAskCents + offer) / 2));
    if (f.lastCounterCents != null) counter = Math.max(f.floorCents, Math.min(counter, f.lastCounterCents));
    // The last allowed counter is final when there is no room left to move.
    const final = f.countersUsed >= MAX_COUNTERS - 1 && counter === f.floorCents;
    return { action: 'counter', priceCents: counter, final };
  }

  const best = f.bestOtherOfferCents;
  if (best != null && best > 0 && offer < best * 0.95) {
    return { action: 'match_higher', priceCents: best, final: false };
  }
  return { action: 'accept_conditional', priceCents: offer, final: false };
}

/** acceptOffer gate: offer >= floor, or an approval from Henri. The model cannot pass this by writing words. */
export function canAccept(offerCents: number, floorCents: number, belowFloorApproved: boolean): boolean {
  return (Number.isFinite(offerCents) && offerCents >= floorCents) || belowFloorApproved;
}

/** Pressure lines are allowed only with real interest behind them. */
export function mayMentionOtherInterest(inquiriesLast24h: number): boolean {
  return inquiriesLast24h >= 2;
}

/** Max 1 outbound per buyer per 10 minutes outside demo mode. */
export function canSendNow(lastOutboundAt: Date | null | undefined, now: Date, demoMode: boolean): boolean {
  if (demoMode || !lastOutboundAt) return true;
  return now.getTime() - lastOutboundAt.getTime() >= OUTBOUND_COOLDOWN_MS;
}

// ---------- checking the words ----------

export interface ReplyCheck {
  ok: boolean;
  reasons: string[];
  amounts: number[];
}

export interface ReplyRules {
  floorCents: number;
  /** The number code decided. The reply must state it. */
  requiredCents?: number;
  /** Lowest amount the reply may state. Defaults to the floor; an approved below-floor deal lowers it. */
  minAllowedCents?: number;
  /** A real competing offer, the only other number the reply may quote above the decided one. */
  bestOtherOfferCents?: number | null;
  mayMentionOtherInterest?: boolean;
  addressAllowed?: boolean;
  meetingSpot?: string | null;
}

const OTHER_INTEREST_RE = /\b(?:someone|somebody|another|other)\s+(?:else\s+)?(?:buyers?|person|people|folks?|offers?|inquir|is\s+interested|asked|are\s+interested)|\b(?:lots?|plenty|a\s+lot)\s+of\s+(?:interest|people|buyers)|\bhigher\s+offer\b/i;

/**
 * Output validation, run on every proposed reply. Any dollar amount below the floor
 * rejects the reply. So does a missing decided number, invented interest, or an early address.
 */
export function validateReply(text: string, rules: ReplyRules): ReplyCheck {
  const reasons: string[] = [];
  const amounts = [...extractDollarAmounts(text)];
  const min = rules.minAllowedCents ?? rules.floorCents;
  if (!text.trim()) reasons.push('empty reply');
  for (const a of amounts) {
    if (a < min) reasons.push(`states ${dollars(a)}, below the minimum ${dollars(min)}`);
  }
  if (rules.requiredCents != null && !amounts.includes(rules.requiredCents)) {
    reasons.push(`must state ${dollars(rules.requiredCents)}`);
  }
  if (rules.mayMentionOtherInterest === false && rules.bestOtherOfferCents == null && OTHER_INTEREST_RE.test(text)) {
    reasons.push('mentions other interest that is not real');
  }
  if (rules.addressAllowed === false && rules.meetingSpot && rules.meetingSpot.length > 3 && text.toLowerCase().includes(rules.meetingSpot.toLowerCase())) {
    reasons.push('discloses the address before the address clock');
  }
  return { ok: reasons.length === 0, reasons, amounts };
}

/** No em dashes, no emojis in agent replies. */
export function cleanReply(text: string): string {
  return text
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/ {2,}/g, ' ')
    .trim();
}

// ---------- templates used when the model is not trusted with the words ----------

export function fallbackReply(floorCents: number, slots: string[]): string {
  const pick = slots.length > 0 ? ` If that works, pick a time: ${slots.join(', ')}.` : ' If that works, tell me when you can pick up.';
  return `I can't go below ${dollars(floorCents)}.${pick}`;
}

export function injectionReply(standingCents: number, slots: string[]): string {
  const pick = slots.length > 0 ? ` If you want it, pick a time: ${slots.join(', ')}.` : ' If you want it, tell me when you can pick up.';
  return `Nice try. ${dollars(standingCents)} stands.${pick}`;
}

export const ADDRESS_GATE_REPLY = (time: string) => `I'll send the exact address two hours before pickup. See you at ${time}.`;
export const PENDING_REPLY = "It's pending with another buyer. I'll let you know if it falls through.";
