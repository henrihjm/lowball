// scheduleSlot: books the pickup. Validated in code: accepted price, time inside
// Henri's pickup windows (or allowed by him), item not already pending with someone else.
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { q, q1 } from '../../db/client.js';
import { activeSlot, addClock, firstName, getBuyer, getItem, getUser, logOutbound, type Buyer, type Message } from '../../db/repo.js';
import { now } from '../../demo/clock.js';
import { replyInThread } from '../../email/agentmail.js';
import { sendPickupInvite } from '../../email/invite.js';
import { listingsUrl } from '../../listings.js';
import { PENDING_REPLY } from '../../policy/negotiation.js';
import { formatSlotLong, isInsideWindows, parseWindows } from '../../policy/windows.js';
import { notifyOwner } from '../../telegram/notify.js';
import { pickupBooked } from '../../telegram/templates.js';

const HOUR = 3_600_000;

export type ScheduleResult =
  | { ok: true; slotId: string; startsAt: Date }
  | { ok: false; reason: 'no_accepted_offer' | 'outside_windows' | 'pending_other_buyer' | 'in_the_past' | 'blocked' | 'unknown_buyer' };

export async function lastInboundId(buyerId: string): Promise<string | null> {
  const m = await q1<Pick<Message, 'agentmail_message_id'>>(
    "select agentmail_message_id from messages where buyer_id = $1 and direction = 'in' and agentmail_message_id is not null order by created_at desc limit 1",
    [buyerId],
  );
  return m?.agentmail_message_id ?? null;
}

/** Send a templated line in a buyer's thread and log it with its reasoning. */
export async function sendToBuyer(buyer: Buyer, text: string, intent: string, reasoning: string): Promise<void> {
  const item = await getItem(buyer.item_id);
  if (!item?.inbox_id) return;
  const sent = await replyInThread(
    { inboxId: item.inbox_id, lastInboundMessageId: await lastInboundId(buyer.id), to: buyer.email, subject: item.title },
    text,
  );
  await logOutbound({ buyerId: buyer.id, body: text, intent, reasoning, floorCents: item.floor_cents, askCents: item.ask_cents, agentmailMessageId: sent.messageId });
}

/** Clocks created on confirmation: address at T-2h, reminder at T-1h, no-show check at T+30m, sold check at T+1h. */
async function createSlotClocks(slotId: string, itemId: string, buyerId: string, startsAt: Date): Promise<void> {
  const t = startsAt.getTime();
  const payload = { slot_id: slotId, item_id: itemId, buyer_id: buyerId };
  const dayOf = new Date(startsAt.getFullYear(), startsAt.getMonth(), startsAt.getDate(), 8, 0);
  await addClock('day_of', new Date(Math.min(dayOf.getTime(), t - 2 * HOUR - 60_000)), payload);
  await addClock('send_address', new Date(t - 2 * HOUR), payload);
  await addClock('remind_buyer', new Date(t - 1 * HOUR), payload);
  await addClock('check_noshow', new Date(t + HOUR / 2), payload);
  await addClock('sold_check', new Date(t + HOUR), payload);
}

export async function scheduleSlotCore(buyerId: string, startsAt: Date, opts: { allowOutsideWindows?: boolean } = {}): Promise<ScheduleResult> {
  const buyer = await getBuyer(buyerId);
  if (!buyer) return { ok: false, reason: 'unknown_buyer' };
  if (buyer.status === 'blocked') return { ok: false, reason: 'blocked' };
  if (buyer.agreed_cents == null) return { ok: false, reason: 'no_accepted_offer' };
  const item = (await getItem(buyer.item_id))!;
  const user = await getUser(item.user_id);
  if (startsAt.getTime() <= now().getTime()) return { ok: false, reason: 'in_the_past' };
  if (!opts.allowOutsideWindows && !isInsideWindows(startsAt, parseWindows(user.pickup_windows))) return { ok: false, reason: 'outside_windows' };

  const existing = await activeSlot(item.id);
  if (existing && existing.buyer_id !== buyerId) return { ok: false, reason: 'pending_other_buyer' };
  if (existing) {
    // Same buyer moving their own slot: retire the old one and its clocks.
    await q("update slots set status = 'proposed' where id = $1", [existing.id]);
    await q("update clocks set done_at = $2 where done_at is null and payload->>'slot_id' = $1", [existing.id, now()]);
  }

  const slot = (await q1<{ id: string }>(
    "insert into slots (item_id, buyer_id, starts_at, status) values ($1, $2, $3, 'confirmed') returning id",
    [item.id, buyerId, startsAt],
  ))!;
  await q("update buyers set status = 'confirmed', proposed_at = $2 where id = $1", [buyerId, startsAt]);
  await q("update items set status = 'pending' where id = $1", [item.id]);
  await createSlotClocks(slot.id, item.id, buyerId, startsAt);

  // Other active buyers at or above the floor go to the backup queue, with one line each.
  const others = await q<Buyer>(
    "select * from buyers where item_id = $1 and id <> $2 and status = 'active' and last_offer_cents >= $3",
    [item.id, buyerId, item.floor_cents],
  );
  for (const other of others) {
    await q("update buyers set status = 'backup' where id = $1", [other.id]);
    await sendToBuyer(other, PENDING_REPLY, 'other', 'Another buyer confirmed a slot. Moved to the backup queue.').catch((err) =>
      console.error('[slot] backup notice failed:', (err as Error).message),
    );
  }

  const invited = await sendPickupInvite({
    slotId: slot.id,
    itemTitle: item.title ?? 'item',
    buyerName: firstName(buyer),
    cents: buyer.agreed_cents,
    startsAt,
    spot: user.meeting_spot,
    payment: user.payment_methods,
    inboxId: item.inbox_id!,
    inboxAddress: item.inbox_address ?? '',
    listingsUrl: listingsUrl(),
  });
  await notifyOwner(`${pickupBooked(firstName(buyer), buyer.agreed_cents, formatSlotLong(startsAt))}${invited ? ' The calendar invite is in your email.' : ''}`);
  return { ok: true, slotId: slot.id, startsAt };
}

export const scheduleSlot = createTool({
  id: 'scheduleSlot',
  description:
    "Book a pickup slot for a buyer whose offer was accepted. Validated in code: the time must be inside Henri's pickup windows and the item must not be pending with another buyer.",
  inputSchema: z.object({ buyer_id: z.string(), starts_at: z.string().describe('Local ISO 8601 time, exactly as given in the facts') }),
  outputSchema: z.object({ ok: z.boolean(), starts_at: z.string().optional(), reason: z.string().optional() }),
  execute: async (input) => {
    const when = new Date(input.starts_at);
    if (Number.isNaN(when.getTime())) return { ok: false, reason: 'invalid time' };
    const res = await scheduleSlotCore(input.buyer_id, when);
    return res.ok ? { ok: true, starts_at: res.startsAt.toISOString() } : { ok: false, reason: res.reason };
  },
});
