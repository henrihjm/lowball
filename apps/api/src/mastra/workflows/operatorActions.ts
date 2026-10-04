// The actions Henri can take by typing. Each returns one confirming line.
import { json, q, q1 } from '../../db/client.js';
import { activeSlot, currentItem, firstName, getUser, type Buyer, type Item, type Message } from '../../db/repo.js';
import { clockInfo, now, setManualCompression } from '../../demo/clock.js';
import { env } from '../../env.js';
import { dollars } from '../../policy/pricing.js';
import { formatSlot, formatSlotLong, parseWindows, upcomingSlots } from '../../policy/windows.js';
import { acceptOfferCore } from '../tools/acceptOffer.js';
import { sendToBuyer } from '../tools/scheduleSlot.js';
import { digestText, itemStats, markSold, relist } from './lifecycle.js';

const NO_ITEM = 'Nothing is listed right now. Send me a photo to start.';

export async function status(): Promise<string> {
  const item = await currentItem();
  if (!item) return NO_ITEM;
  const s = await itemStats(item.id);
  const slot = await activeSlot(item.id);
  const slotBuyer = slot ? await q1<Buyer>('select * from buyers where id = $1', [slot.buyer_id]) : undefined;
  return [
    `${item.title}: ${item.status}. Ask ${dollars(item.ask_cents)}, floor ${dollars(item.floor_cents)}.`,
    `${s.inquiries} buyer${s.inquiries === 1 ? '' : 's'}, best offer ${s.bestCents != null ? dollars(s.bestCents) : 'none'}, ${s.backups} in backup, ${s.scams} blocked.`,
    slot && slotBuyer ? `Pickup ${formatSlotLong(slot.starts_at)} with ${firstName(slotBuyer)} at ${dollars(slotBuyer.agreed_cents)}.` : 'No pickup booked yet.',
    `Buyers write to ${item.inbox_address ?? 'no inbox yet'}.`,
  ].join('\n');
}

export async function setFloor(dollarsValue: number): Promise<string> {
  const item = await currentItem();
  if (!item) return NO_ITEM;
  const cents = Math.round(dollarsValue * 100);
  if (!(cents > 0)) return 'Give me a floor above zero.';
  if (item.ask_cents != null && cents > item.ask_cents) return `The floor can't be above the ask (${dollars(item.ask_cents)}). Change the ask first.`;
  await q('update items set floor_cents = $2 where id = $1', [item.id, cents]);
  return `Floor is now ${dollars(cents)} (was ${dollars(item.floor_cents)}). It applies to every reply from here on.`;
}

export async function setAsk(dollarsValue: number): Promise<string> {
  const item = await currentItem();
  if (!item) return NO_ITEM;
  const cents = Math.round(dollarsValue * 100);
  if (item.floor_cents != null && cents < item.floor_cents) return `The ask can't be below the floor (${dollars(item.floor_cents)}). Drop the floor first.`;
  await q('update items set ask_cents = $2 where id = $1', [item.id, cents]);
  return `Ask is now ${dollars(cents)} (was ${dollars(item.ask_cents)}).`;
}

export async function pause(): Promise<string> {
  const item = await currentItem();
  if (!item) return NO_ITEM;
  await q("update items set status = 'paused' where id = $1", [item.id]);
  return `Paused ${item.title}. I won't answer buyers until you say relist.`;
}

export async function relistItem(): Promise<string> {
  const item = await currentItem();
  if (!item) return NO_ITEM;
  await relist(item.id);
  return `${item.title} is listed again at ${dollars(item.ask_cents)}.`;
}

export async function sold(dollarsValue?: number): Promise<string> {
  const item = await currentItem();
  if (!item) return NO_ITEM;
  const slot = await activeSlot(item.id);
  const slotBuyer = slot ? await q1<Buyer>('select * from buyers where id = $1', [slot.buyer_id]) : undefined;
  const cents = dollarsValue != null ? Math.round(dollarsValue * 100) : slotBuyer?.agreed_cents ?? item.ask_cents ?? 0;
  return markSold(item.id, cents);
}

export async function deleteItem(): Promise<string> {
  const item = await currentItem();
  if (!item) return NO_ITEM;
  await q("update items set status = 'deleted' where id = $1", [item.id]);
  await q("update clocks set done_at = $2 where done_at is null and payload->>'item_id' = $1", [item.id, now()]);
  return `Deleted ${item.title}. Buyers get no more replies.${item.craigslist_url ? ` Take the Craigslist post down: ${item.craigslist_url}` : ''}`;
}

export async function digest(): Promise<string> {
  const items = await q<Item>("select * from items where status in ('listed','pending') order by listed_at");
  if (items.length === 0) return NO_ITEM;
  return (await Promise.all(items.map(digestText))).join('\n');
}

async function rankedBuyers(itemId: string): Promise<Buyer[]> {
  return q<Buyer>('select * from buyers where item_id = $1 order by score desc, last_inbound desc nulls last', [itemId]);
}

export async function showBuyer(n: number): Promise<string> {
  const item = await currentItem();
  if (!item) return NO_ITEM;
  const buyers = await rankedBuyers(item.id);
  const b = buyers[n - 1];
  if (!b) return buyers.length === 0 ? 'No buyers yet.' : `There are ${buyers.length} buyers. Pick 1 to ${buyers.length}.`;
  const last = await q<Message>('select * from messages where buyer_id = $1 and body is not null order by created_at desc limit 2', [b.id]);
  const lines = last.reverse().map((m) => `${m.direction === 'in' ? 'Them' : 'Me'}: ${m.body!.slice(0, 200)}`);
  return [
    `#${n} ${firstName(b)} (${b.status}), score ${Number(b.score).toFixed(2)}. Offer ${b.agreed_cents ?? b.last_offer_cents ? dollars(b.agreed_cents ?? b.last_offer_cents) : 'none'}${b.proposed_time ? `, ${b.proposed_time}` : ''}.`,
    ...lines,
  ].join('\n');
}

/** Henri says "take the best offer": his word is the approval, recorded as a resolved below_floor decision. */
export async function takeBestOffer(): Promise<string> {
  const item = await currentItem();
  if (!item) return NO_ITEM;
  if (await activeSlot(item.id)) return 'A pickup is already booked. Say relist first if it fell through.';
  const best = await q1<Buyer>(
    "select * from buyers where item_id = $1 and status in ('active','backup') and last_offer_cents is not null order by last_offer_cents desc, score desc limit 1",
    [item.id],
  );
  if (!best) return 'No offers yet.';
  const offer = best.last_offer_cents!;
  if (item.floor_cents != null && offer < item.floor_cents) {
    await q(
      "insert into decisions (item_id, buyer_id, kind, payload, options, chosen, resolved_at, created_at) values ($1, $2, 'below_floor', $3::jsonb, $4::jsonb, 'take_it', $5, $5)",
      [item.id, best.id, json({ offer_cents: offer, floor_cents: item.floor_cents, via: 'operator' }), json([{ key: 'take_it', label: 'Take it' }]), now()],
    );
  }
  const res = await acceptOfferCore(best.id, offer);
  if (!res.ok) return `Could not accept ${dollars(offer)}: ${res.reason}.`;
  await q("update buyers set status = 'active' where id = $1", [best.id]);
  const user = await getUser(item.user_id);
  const slots = upcomingSlots(parseWindows(user.pickup_windows), now(), 3).map(formatSlot);
  await sendToBuyer(
    best,
    `${dollars(offer)} works. ${slots.length > 0 ? `I can do ${slots.join(', ')}. Which works?` : 'When could you pick up?'}`,
    'accept_needs_time',
    `Henri said to take the best offer (${dollars(offer)}). Accepted through acceptOffer.`,
  );
  return `Taking ${dollars(offer)} from ${firstName(best)}. Asked them to pick a slot.`;
}

export function clock(action: 'fast_forward' | 'pause'): string {
  if (!env.DEMO_MODE) return 'The clock only moves in demo mode.';
  setManualCompression(action === 'fast_forward');
  const info = clockInfo();
  return action === 'fast_forward' ? 'Fast forward: one day every 5 seconds. Say "pause clock" to stop.' : `Clock back to real time. It is ${formatSlotLong(new Date(info.now))} on the demo clock.`;
}

export async function setSpot(spot: string): Promise<string> {
  await q("update users set meeting_spot = $1 where id = 'henri'", [spot.trim()]);
  return `Pickup spot saved: ${spot.trim()}. Buyers only get it two hours before a confirmed pickup.`;
}

export async function setWindows(text: string): Promise<string> {
  if (parseWindows(text).length === 0) return 'I could not read that. Send it like "windows Tue/Thu 18:00-20:00, Sat 10:00-12:00".';
  await q("update users set pickup_windows = $1 where id = 'henri'", [text.trim()]);
  return `Pickup windows saved: ${text.trim()}.`;
}

export const HELP =
  'Try: status · digest · floor 150 · ask 200 · show buyer 2 · take best offer · sold 180 · pause · relist · delete · spot <where> · windows <days and times>. In demo mode: fast forward · pause clock.';
