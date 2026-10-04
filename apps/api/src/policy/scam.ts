// Rule-based scam patterns. These run before the LLM and are decisive when they match.

export interface ScamContext {
  askCents?: number | null;
  offerCents?: number | null;
  pickupOnly?: boolean;
}

export interface ScamMatch {
  rule: string;
  label: string;
}

interface TextRule extends ScamMatch {
  test: (text: string) => boolean;
}

const has = (re: RegExp) => (t: string) => re.test(t);

const TEXT_RULES: TextRule[] = [
  { rule: 'cashiers_check', label: "cashier's check", test: has(/\bcashier'?s?\s+che(?:ck|que)\b/i) },
  { rule: 'certified_check', label: 'certified check', test: has(/\bcertified\s+(?:che(?:ck|que)|funds)\b/i) },
  { rule: 'money_order', label: 'money order', test: has(/\bmoney\s+order\b/i) },
  {
    rule: 'third_party_pickup',
    label: 'third party pickup (courier, mover, shipper, assistant)',
    test: has(
      /\b(?:my|our|a|the)\s+(?:courier|movers?|moving\s+(?:company|agent)|shipp(?:er|ing\s+(?:agent|company))|assistant|secretary|pick-?up\s+agent|agent|driver)\b[^.!?\n]{0,60}\b(?:pick|collect|come|handle|arrange)/i,
    ),
  },
  {
    rule: 'paypal_invoice',
    label: 'PayPal invoice or payment link from the buyer',
    test: has(/\bpaypal\b[^.!?\n]{0,40}\b(?:invoice|payment\s+link|link|request)\b|\b(?:send|email)\s+(?:you\s+)?(?:a|the|my)\s+(?:paypal\s+)?(?:payment\s+link|invoice)\b/i),
  },
  {
    rule: 'zelle_overpayment',
    label: 'Zelle overpayment',
    test: (t) => /\bzelle\b/i.test(t) && /\b(?:overpa(?:y|id|yment)|extra|refund|send\s+(?:back|the\s+(?:difference|rest|balance))|business\s+account|upgrade)\b/i.test(t),
  },
  {
    rule: 'verification_code',
    label: 'verification code request (Google Voice scam)',
    test: has(/\b(?:verification|verify|6[-\s]?digit|google\s+voice|confirmation)\b[^.!?\n]{0,30}\bcode\b|\bcode\b[^.!?\n]{0,40}\b(?:read|send|tell|text)\s+(?:it\s+)?(?:back|to\s+me)\b|\b(?:your|ur)\s+(?:phone\s+)?number\b[^.!?\n]{0,60}\b(?:code|verif)/i),
  },
  {
    rule: 'wants_shipping',
    label: 'wants it shipped, listing is pickup only',
    test: has(/\b(?:ship(?:ped|ping|ment)?\s+(?:it|this|the|to|out|cost|fee|label)|can\s+you\s+ship|pay\s+(?:for\s+)?shipping|shipping\s+(?:address|agent|label|fee)|mail\s+it\s+to|via\s+(?:fedex|ups|usps|dhl))\b/i),
  },
];

/** Returns every matched rule. Empty array means no rule matched. */
export function matchScamRules(text: string, ctx: ScamContext = {}): ScamMatch[] {
  const matches: ScamMatch[] = [];
  for (const r of TEXT_RULES) {
    if (r.rule === 'wants_shipping' && ctx.pickupOnly === false) continue;
    if (r.test(text)) matches.push({ rule: r.rule, label: r.label });
  }
  if (ctx.askCents != null && ctx.offerCents != null && ctx.offerCents > ctx.askCents) {
    matches.push({ rule: 'above_asking_unseen', label: 'offers above asking without seeing the item' });
  }
  return matches;
}

export function isScam(text: string, ctx: ScamContext = {}): boolean {
  return matchScamRules(text, ctx).length > 0;
}
