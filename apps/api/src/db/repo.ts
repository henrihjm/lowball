// Row types and the handful of queries shared across workflows.
import { now } from '../demo/clock.js';
import { json, q, q1 } from './client.js';

export interface User {
  id: string;
  telegram_chat_id: number | null;
  neighborhood: string | null;
  pickup_windows: string | null;
  payment_methods: string | null;
  meeting_spot: string | null;
}

export interface Comp {
  title: string;
  price_cents: number;
  url: string;
  source: string;
}

export interface Item {
  id: string;
  user_id: string;
  status: 'draft' | 'listed' | 'pending' | 'sold' | 'paused' | 'deleted';
  title: string | null;
  description: string | null;
  condition_notes: string | null;
  photos: { telegram_file_id?: string; url?: string; data?: string; mime?: string }[] | null;
  ask_cents: number | null;
  floor_cents: number | null;
  decay_pct: number;
  decay_every_days: number;
  listed_at: Date | null;
  sold_at: Date | null;
  sold_cents: number | null;
  inbox_id: string | null;
  inbox_address: string | null;
  craigslist_url: string | null;
  ebay_url: string | null;
  comps: Comp[] | null;
  kernel_live_view_url: string | null;
  card_message_id: number | null;
  created_at: Date;
}

export interface Buyer {
  id: string;
  item_id: string;
  email: string;
  display_name: string | null;
  thread_id: string | null;
  status: 'active' | 'blocked' | 'confirmed' | 'backup' | 'noshow' | 'closed';
  score: number;
  counters_used: number;
  last_offer_cents: number | null;
  first_seen: Date;
  last_inbound: Date | null;
  last_outbound: Date | null;
  scam_flags: { rule: string; label: string }[];
  proposed_time: string | null;
  last_counter_cents: number | null;
  agreed_cents: number | null;
  proposed_at: Date | null;
}

export interface Message {
  id: string;
  buyer_id: string;
  direction: 'in' | 'out';
  agentmail_message_id: string | null;
  body: string | null;
  intent: string | null;
  offer_cents: number | null;
  reasoning: string | null;
  floor_at_time_cents: number | null;
  ask_at_time_cents: number | null;
  handled_at: Date | null;
  created_at: Date;
}

export interface Slot {
  id: string;
  item_id: string;
  buyer_id: string;
  starts_at: Date;
  status: 'proposed' | 'confirmed' | 'address_sent' | 'reminded' | 'completed' | 'noshow';
  address_sent_at: Date | null;
  buyer_confirmed_at: Date | null;
}

export interface DecisionRow {
  id: string;
  item_id: string | null;
  buyer_id: string | null;
  kind: 'below_floor' | 'slot_conflict' | 'scam_unsure' | 'noshow' | 'sold_check';
  payload: Record<string, any> | null;
  options: { key: string; label: string }[] | null;
  chosen: string | null;
  resolved_at: Date | null;
  created_at: Date;
}

export interface Clock {
  id: string;
  due_at: Date;
  kind: string;
  payload: Record<string, any> | null;
  done_at: Date | null;
}

export const ACTIVE_SLOT = ['confirmed', 'address_sent', 'reminded'];

export const getUser = async (id = 'henri') => (await q1<User>('select * from users where id = $1', [id]))!;
export const getItem = (id: string) => q1<Item>('select * from items where id = $1', [id]);
export const getBuyer = (id: string) => q1<Buyer>('select * from buyers where id = $1', [id]);

/** The item buyers on this inbox are writing about: the most recently listed live item. */
export function itemForInbox(inboxId: string) {
  return q1<Item>(
    "select * from items where inbox_id = $1 and status in ('listed','pending') order by listed_at desc nulls last, created_at desc limit 1",
    [inboxId],
  );
}

/** The item Henri is talking about when he does not say which: the latest live one. */
export function currentItem() {
  return q1<Item>(
    "select * from items where status in ('listed','pending','paused') order by listed_at desc nulls last, created_at desc limit 1",
  );
}

export function activeSlot(itemId: string) {
  return q1<Slot>(`select * from slots where item_id = $1 and status = any($2::text[]) order by starts_at limit 1`, [itemId, ACTIVE_SLOT]);
}

export async function addClock(kind: string, dueAt: Date, payload: Record<string, any>): Promise<void> {
  await q('insert into clocks (due_at, kind, payload) values ($1, $2, $3::jsonb)', [dueAt, kind, json(payload)]);
}

export interface OutboundLog {
  buyerId: string;
  body: string;
  intent: string;
  reasoning: string;
  offerCents?: number | null;
  floorCents?: number | null;
  askCents?: number | null;
  agentmailMessageId?: string | null;
}

/** Every outbound reply writes a messages row with reasoning and the floor at the time. The board reads these. */
export async function logOutbound(o: OutboundLog): Promise<void> {
  const at = now();
  await q(
    `insert into messages (buyer_id, direction, agentmail_message_id, body, intent, offer_cents, reasoning, floor_at_time_cents, ask_at_time_cents, created_at)
     values ($1, 'out', $2, $3, $4, $5, $6, $7, $8, $9) on conflict (agentmail_message_id) do nothing`,
    [o.buyerId, o.agentmailMessageId ?? null, o.body, o.intent, o.offerCents ?? null, o.reasoning, o.floorCents ?? null, o.askCents ?? null, at],
  );
  await q('update buyers set last_outbound = $2 where id = $1', [o.buyerId, at]);
}

/** A reasoning-only row: the agent decided not to reply (blocked, held, rate limited). */
export async function logNote(buyerId: string, intent: string, reasoning: string, floorCents?: number | null, askCents?: number | null): Promise<void> {
  await q(
    `insert into messages (buyer_id, direction, body, intent, reasoning, floor_at_time_cents, ask_at_time_cents, created_at)
     values ($1, 'out', null, $2, $3, $4, $5, $6)`,
    [buyerId, intent, reasoning, floorCents ?? null, askCents ?? null, now()],
  );
}

export const firstName = (b: Pick<Buyer, 'display_name' | 'email'>) =>
  (b.display_name?.trim().split(/\s+/)[0] || b.email.split('@')[0] || 'Buyer').slice(0, 24);
