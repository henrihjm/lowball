// The shape of GET /api/state on apps/api (see apps/api/src/state.ts), after JSON:
// amounts are integer cents, dates are ISO strings.

export type BuyerStatus = 'active' | 'blocked' | 'confirmed' | 'backup' | 'noshow' | 'closed';
export type ItemStatus = 'draft' | 'listed' | 'pending' | 'sold' | 'paused' | 'deleted';
export type SlotStatus = 'proposed' | 'confirmed' | 'address_sent' | 'reminded' | 'completed' | 'noshow';

export interface ScamFlag {
  rule: string;
  label: string;
}

export interface BoardMessage {
  id: string;
  direction: 'in' | 'out';
  /** null on an outbound row means a reasoning-only note: the agent decided not to reply. */
  body: string | null;
  intent: string | null;
  reasoning: string | null;
  offerCents: number | null;
  floorCents: number | null;
  askCents: number | null;
  at: string;
}

export interface BuyerThread {
  buyerId: string;
  name: string;
  email: string;
  status: BuyerStatus;
  scamFlags: ScamFlag[];
  lastAt: string;
  messages: BoardMessage[];
}

export interface BuyerRow {
  id: string;
  name: string;
  email: string;
  status: BuyerStatus;
  score: number;
  lastOfferCents: number | null;
  agreedCents: number | null;
  countersUsed: number;
  proposedTime: string | null;
  scamFlags: ScamFlag[];
}

export interface ItemStats {
  inquiries: number;
  lowballs: number;
  scams: number;
  noshows: number;
  backups: number;
  bestCents: number | null;
}

export interface ItemSlot {
  startsAt: string;
  status: SlotStatus;
  buyerName: string | null;
  agreedCents: number | null;
  addressAt: string;
  addressSentAt: string | null;
}

export interface ItemView {
  id: string;
  title: string | null;
  status: ItemStatus;
  description: string | null;
  askCents: number | null;
  floorCents: number | null;
  decayPct: number;
  decayEveryDays: number;
  nextDecayAt: string | null;
  listedAt: string | null;
  soldCents: number | null;
  inboxAddress: string | null;
  craigslistUrl: string | null;
  kernelLiveViewUrl: string | null;
  hasPhoto: boolean;
  stats: ItemStats;
  slot: ItemSlot | null;
}

export interface TelegramLine {
  text: string;
  buttons?: { text: string; data: string }[];
  at: string;
}

export interface BoardClock {
  now: string;
  rate: number;
  compressing: boolean;
  mode: string;
  manual: boolean;
}

export interface BoardState {
  clock: BoardClock;
  demoMode: boolean;
  queue: { running: number; waiting: number };
  items: { id: string; title: string | null; status: ItemStatus }[];
  telegram: TelegramLine[];
  item: ItemView | null;
  buyers: BuyerRow[];
  threads: BuyerThread[];
  /** Set by the board's own proxy when it serves built-in sample data instead of the API. */
  sample?: boolean;
}
