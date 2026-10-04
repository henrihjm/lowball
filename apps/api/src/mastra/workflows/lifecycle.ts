// Item lifecycle after the negotiation: post, no-show, backup promotion, sold, digest.
import { q, q1 } from '../../db/client.js';
import { activeSlot, addClock, firstName, getItem, getUser, type Buyer, type Item, type Slot } from '../../db/repo.js';
import { DAY_MS, now } from '../../demo/clock.js';
import { createInbox, getInbox, mailEnabled } from '../../email/agentmail.js';
import { env } from '../../env.js';
import { formatSlot, formatSlotLong, parseWindows, upcomingSlots } from '../../policy/windows.js';
import { dollars } from '../../policy/pricing.js';
import { notifyOwner } from '../../telegram/notify.js';
import * as tpl from '../../telegram/templates.js';
import { acceptOfferCore } from '../tools/acceptOffer.js';
import { sendToBuyer } from '../tools/scheduleSlot.js';

export interface ItemStats {
  inquiries: number;
  lowballs: number;
  scams: number;
  noshows: number;
  backups: number;
  bestCents: number | null;
}

export async function itemStats(itemId: string): Promise<ItemStats> {
  const row = (await q1<ItemStats>(
    `select
       (select count(*)::int from buyers where item_id = $1) as inquiries,
       (select count(*)::int from messages m join buyers b on b.id = m.buyer_id where b.item_id = $1 and m.direction = 'out' and m.intent in ('counter','counter_final','injection')) as lowballs,
       (select count(*)::int from buyers where item_id = $1 and status = 'blocked') as scams,
       (select count(*)::int from slots where item_id = $1 and status = 'noshow') as noshows,
       (select count(*)::int from buyers where item_id = $1 and status = 'backup') as backups,
       (select max(coalesce(agreed_cents, last_offer_cents)) from buyers where item_id = $1 and status <> 'blocked') as "bestCents"`,
    [itemId],
  ))!;
  return row;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'item';

/** Post creates the item's inbox mapping and starts the clocks. Returns the inbox address buyers write to. */
export async function postItem(itemId: string): Promise<string> {
  const item = (await getItem(itemId))!;
  let inboxId = item.inbox_id;
  let address = item.inbox_address;
  if (!inboxId) {
    if (mailEnabled()) {
      try {
        // One inbox per item is cleanest: the inbox address is the Craigslist poster email.
        const inbox = await createInbox(`lowball-${slug(item.title ?? 'item')}-${item.id.slice(0, 4)}`, `lowball-item-${item.id}`, 'Lowball');
        inboxId = inbox.inboxId;
        address = inbox.email;
      } catch (err) {
        console.warn('[post] could not create an inbox for the item, using the demo inbox:', (err as Error).message);
      }
    }
    if (!inboxId && env.AGENTMAIL_DEMO_INBOX_ID && mailEnabled()) {
      const inbox = await getInbox(env.AGENTMAIL_DEMO_INBOX_ID);
      inboxId = inbox.inboxId;
      address = inbox.email;
    }
    if (!inboxId) {
      inboxId = `local-${item.id.slice(0, 8)}`;
      address = `${inboxId}@sim.lowball`;
    }
  }
  const at = now();
  await q("update items set status = 'listed', listed_at = $2, inbox_id = $3, inbox_address = $4 where id = $1", [itemId, at, inboxId, address]);
  await addClock('decay', new Date(at.getTime() + item.decay_every_days * DAY_MS), { item_id: itemId });
  return address!;
}

async function cancelSlotClocks(slotId: string): Promise<void> {
  await q("update clocks set done_at = $2 where done_at is null and payload->>'slot_id' = $1", [slotId, now()]);
}

/** Marks the slot a no-show and puts the item back on the market. */
export async function markNoShow(slot: Slot): Promise<void> {
  await q("update slots set status = 'noshow' where id = $1", [slot.id]);
  await q("update buyers set status = 'noshow' where id = $1", [slot.buyer_id]);
  await q("update items set status = 'listed' where id = $1 and status = 'pending'", [slot.item_id]);
  await cancelSlotClocks(slot.id);
}

export async function topBackup(itemId: string): Promise<Buyer | undefined> {
  return q1<Buyer>("select * from buyers where item_id = $1 and status = 'backup' order by score desc, coalesce(agreed_cents, last_offer_cents) desc nulls last limit 1", [itemId]);
}

async function slotLines(item: Item): Promise<string[]> {
  const user = await getUser(item.user_id);
  return upcomingSlots(parseWindows(user.pickup_windows), now(), 3).map(formatSlot);
}

/** Promote the top backup: the item is theirs at their price if they can pick a slot. */
export async function promoteBackup(itemId: string): Promise<Buyer | undefined> {
  const backup = await topBackup(itemId);
  if (!backup) return undefined;
  const item = (await getItem(itemId))!;
  const price = backup.agreed_cents ?? backup.last_offer_cents ?? item.ask_cents!;
  await q("update buyers set status = 'active' where id = $1", [backup.id]);
  await acceptOfferCore(backup.id, price);
  const slots = await slotLines(item);
  await sendToBuyer(
    { ...backup, status: 'active' },
    `It fell through with the other buyer. It's yours at ${dollars(price)}. ${slots.length > 0 ? `I can do ${slots.join(', ')}. Which works?` : 'When could you pick up?'}`,
    'accept_needs_time',
    'Previous buyer was a no-show. Promoted the top backup by score.',
  );
  return { ...backup, status: 'active' };
}

/** check_noshow with no confirmation and no sale: promote the top backup, tell both buyers, one Telegram line. */
export async function handleNoShow(slot: Slot, opts: { promote: boolean }): Promise<string> {
  const item = (await getItem(slot.item_id))!;
  const buyer = (await q1<Buyer>('select * from buyers where id = $1', [slot.buyer_id]))!;
  await markNoShow(slot);
  await sendToBuyer(buyer, "I didn't hear back, so I've released your pickup slot. Reply if you still want it.", 'other', 'No-show: no confirmation and no pickup. Slot released.').catch(
    () => undefined,
  );
  const promoted = opts.promote ? await promoteBackup(item.id) : undefined;
  const time = formatSlotLong(slot.starts_at);
  if (promoted) {
    return `${tpl.noshow(firstName(buyer), time, { cents: promoted.agreed_cents ?? promoted.last_offer_cents, when: promoted.proposed_time })} Switched to the backup.`;
  }
  return `${tpl.noshow(firstName(buyer), time)} Relisted at ${dollars(item.ask_cents)}.`;
}

export async function markSold(itemId: string, cents: number): Promise<string> {
  const item = (await getItem(itemId))!;
  const at = now();
  const slot = await activeSlot(itemId);
  if (slot) {
    await q("update slots set status = 'completed' where id = $1", [slot.id]);
    await cancelSlotClocks(slot.id);
  }
  await q("update items set status = 'sold', sold_at = $2, sold_cents = $3 where id = $1", [itemId, at, cents]);
  await q("update clocks set done_at = $2 where done_at is null and payload->>'item_id' = $1", [itemId, at]);

  const waitingBuyers = await q<Buyer>("select * from buyers where item_id = $1 and status = 'backup'", [itemId]);
  for (const b of waitingBuyers) {
    await sendToBuyer(b, 'It sold. Thanks for your interest.', 'other', 'Item sold. Closing the backup queue.').catch(() => undefined);
  }
  await q("update buyers set status = 'closed' where item_id = $1 and status in ('active','backup','confirmed')", [itemId]);

  const stats = await itemStats(itemId);
  const days = item.listed_at ? Math.max(0, Math.floor((at.getTime() - item.listed_at.getTime()) / DAY_MS)) : 0;
  // Delisting through Kernel is P2. Until then the post has to come down by hand, and the summary says so.
  const delisted = !item.craigslist_url;
  let text = tpl.soldSummary({ delisted, cents, inquiries: stats.inquiries, lowballs: stats.lowballs, scams: stats.scams, noshows: stats.noshows, days });
  if (!delisted) text += ` Take the Craigslist post down: ${item.craigslist_url}`;
  return text;
}

export async function relist(itemId: string): Promise<void> {
  const slot = await activeSlot(itemId);
  if (slot) await markNoShow(slot);
  await q("update items set status = 'listed' where id = $1 and status in ('pending','paused')", [itemId]);
}

export async function digestText(item: Item): Promise<string> {
  const stats = await itemStats(item.id);
  const slot = await activeSlot(item.id);
  const day = item.listed_at ? Math.floor((now().getTime() - item.listed_at.getTime()) / DAY_MS) + 1 : 1;
  const nextDecay = await q1<{ due_at: Date }>("select due_at from clocks where kind = 'decay' and done_at is null and payload->>'item_id' = $1 order by due_at limit 1", [item.id]);
  const until = item.ask_cents === item.floor_cents ? 'sold (at floor)' : nextDecay ? formatSlotLong(nextDecay.due_at).split(',')[0]! : 'sold';
  return tpl.digest({
    item: item.title ?? 'Item',
    day,
    inquiries: stats.inquiries,
    lowballs: stats.lowballs,
    scams: stats.scams,
    bestCents: stats.bestCents,
    slotStatus: slot ? `pickup ${formatSlotLong(slot.starts_at)}` : 'no slot yet',
    backups: stats.backups,
    askCents: item.ask_cents ?? 0,
    until,
  });
}

/** One Telegram message per listed item. */
export async function sendDigest(): Promise<number> {
  const items = await q<Item>("select * from items where status in ('listed','pending') order by listed_at");
  for (const item of items) await notifyOwner(await digestText(item));
  return items.length;
}
