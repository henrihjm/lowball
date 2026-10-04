// The clocks: address send, reminders, no-show, sold check, digest, price decay.
// A single loop reads due rows from the clocks table. All time comes from demo/clock.ts.
import { q, q1 } from '../../db/client.js';
import { addClock, firstName, getBuyer, getItem, getUser, type Clock, type Item, type Message, type Slot } from '../../db/repo.js';
import { compress, DAY_MS, holdRealtime, isCompressing, manualCompression, now, rewindTo, startAt } from '../../demo/clock.js';
import { env } from '../../env.js';
import { decayStep, dollars } from '../../policy/pricing.js';
import { formatSlotLong } from '../../policy/windows.js';
import { notifyOwner } from '../../telegram/notify.js';
import * as tpl from '../../telegram/templates.js';
import { sendToBuyer } from '../tools/scheduleSlot.js';
import { createDecision } from './decisions.js';
import { respond } from './handleInbound.js';
import { handleNoShow, sendDigest, topBackup } from './lifecycle.js';

const SLOT_KINDS = ['day_of', 'send_address', 'remind_buyer', 'preempt_noshow', 'check_noshow', 'sold_check'];
const HOLD_MS = parseInt(process.env.DEMO_HOLD_SECONDS ?? '20', 10) * 1000;

const slotOf = (c: Clock) => q1<Slot>('select * from slots where id = $1', [c.payload?.slot_id]);
const clockTime = (d: Date) => formatSlotLong(d).split(', ')[1]!;

async function pendingSlotClocks(): Promise<boolean> {
  const row = await q1('select 1 as one from clocks where done_at is null and kind = any($1::text[]) limit 1', [SLOT_KINDS]);
  return Boolean(row);
}

const handlers: Record<string, (c: Clock) => Promise<void>> = {
  /** Day-of morning line to Henri. */
  async day_of(c) {
    const slot = await slotOf(c);
    if (!slot || !['confirmed', 'address_sent', 'reminded'].includes(slot.status)) return;
    const buyer = (await getBuyer(slot.buyer_id))!;
    const item = (await getItem(slot.item_id))!;
    const user = await getUser(item.user_id);
    const t = slot.starts_at.getTime();
    await notifyOwner(
      tpl.dayOf({
        time: clockTime(slot.starts_at),
        name: firstName(buyer),
        cents: buyer.agreed_cents ?? 0,
        payment: user.payment_methods ?? 'cash',
        addressAt: clockTime(new Date(t - 2 * 3_600_000)),
        remindAt: clockTime(new Date(t - 3_600_000)),
      }),
    );
  },

  /** The address goes out two hours before pickup. Never before this clock, whatever the buyer says. */
  async send_address(c) {
    const slot = await slotOf(c);
    if (!slot || slot.status !== 'confirmed') return;
    const buyer = (await getBuyer(slot.buyer_id))!;
    const item = (await getItem(slot.item_id))!;
    const user = await getUser(item.user_id);
    const spot = user.meeting_spot ?? 'the address I will text you';
    await sendToBuyer(
      buyer,
      `Pickup is at ${spot}, ${formatSlotLong(slot.starts_at)}. ${dollars(buyer.agreed_cents)}, ${user.payment_methods ?? 'cash'}.`,
      'schedule',
      'Address clock fired: two hours before the confirmed pickup.',
    );
    // Stamped with the clock's own due time: under compression one tick can overshoot by more than an hour.
    await q("update slots set status = 'address_sent', address_sent_at = $2 where id = $1", [slot.id, c.due_at]);
  },

  async remind_buyer(c) {
    const slot = await slotOf(c);
    if (!slot || !['confirmed', 'address_sent'].includes(slot.status)) return;
    const buyer = (await getBuyer(slot.buyer_id))!;
    const item = (await getItem(slot.item_id))!;
    const user = await getUser(item.user_id);
    await sendToBuyer(buyer, `See you at ${clockTime(slot.starts_at)} at ${user.meeting_spot ?? 'the pickup spot'}. Reply to confirm.`, 'schedule', 'Reminder clock fired: one hour before pickup.');
    await q("update slots set status = 'reminded' where id = $1", [slot.id]);
    // 20 minutes before pickup with no confirmation, Henri gets the pre-emptive no-show decision.
    await addClock('preempt_noshow', new Date(slot.starts_at.getTime() - 20 * 60_000), c.payload ?? {});
  },

  async preempt_noshow(c) {
    const slot = await slotOf(c);
    if (!slot || slot.status !== 'reminded' || slot.buyer_confirmed_at) return;
    if (isCompressing()) return; // nobody can answer inside compressed time
    const buyer = (await getBuyer(slot.buyer_id))!;
    const backup = await topBackup(slot.item_id);
    await createDecision({
      kind: 'noshow',
      itemId: slot.item_id,
      buyerId: slot.buyer_id,
      payload: { slot_id: slot.id },
      options: backup
        ? [
            { key: 'wait', label: 'Wait' },
            { key: 'switch_backup', label: 'Switch to backup' },
          ]
        : [
            { key: 'wait', label: 'Wait' },
            { key: 'relist', label: 'Relist instead' },
          ],
      text: `${firstName(buyer)} hasn't confirmed the ${clockTime(slot.starts_at)} pickup.${backup ? ` Backup (${dollars(backup.agreed_cents ?? backup.last_offer_cents)}, ${backup.proposed_time ?? 'time open'}).` : ''}`,
    });
  },

  async check_noshow(c) {
    const slot = await slotOf(c);
    if (!slot || !['confirmed', 'address_sent', 'reminded'].includes(slot.status)) return;
    const item = (await getItem(slot.item_id))!;
    if (item.status === 'sold' || slot.buyer_confirmed_at) return; // confirmed buyers get the sold check instead
    await notifyOwner(await handleNoShow(slot, { promote: true }));
  },

  async sold_check(c) {
    const slot = await slotOf(c);
    if (!slot || !['confirmed', 'address_sent', 'reminded'].includes(slot.status)) return;
    const item = (await getItem(slot.item_id))!;
    if (item.status === 'sold') return;
    const buyer = (await getBuyer(slot.buyer_id))!;
    await createDecision({
      kind: 'sold_check',
      itemId: item.id,
      buyerId: buyer.id,
      payload: { slot_id: slot.id, cents: buyer.agreed_cents },
      options: [
        { key: 'sold', label: `Sold, ${dollars(buyer.agreed_cents)}` },
        { key: 'noshow', label: 'No-show' },
        { key: 'different', label: 'Different amount' },
      ],
      text: tpl.soldCheck(firstName(buyer), item.title ?? 'item'),
    });
  },

  /** Price decay. Updates ask_cents; never touches floor_cents. */
  async decay(c) {
    const item = await getItem(c.payload?.item_id);
    if (!item || item.ask_cents == null || item.floor_cents == null) return;
    if (!['listed', 'pending', 'paused'].includes(item.status)) return;
    if (item.status === 'listed') {
      const next = decayStep(item.ask_cents, item.floor_cents, Number(item.decay_pct));
      if (next !== item.ask_cents) await q('update items set ask_cents = $2 where id = $1', [item.id, next]);
      if (next <= item.floor_cents) return; // at the floor, nothing left to decay
    }
    await addClock('decay', new Date(c.due_at.getTime() + item.decay_every_days * DAY_MS), { item_id: item.id });
  },

  /** 19:00 local, one message per listed item. */
  async digest(c) {
    await sendDigest();
    const next = new Date(c.due_at);
    next.setDate(next.getDate() + 1);
    await addClock('digest', next, {});
  },

  /** A reply that was held back by the 10 minute rate limit. */
  async reprocess(c) {
    const pending = await q1<Message>(
      "select * from messages where buyer_id = $1 and direction = 'in' and handled_at is null order by created_at desc limit 1",
      [c.payload?.buyer_id],
    );
    if (pending) await respond(pending.buyer_id, pending.id);
  },
};

let ticking = false;

export async function tick(): Promise<number> {
  if (ticking) return 0;
  ticking = true;
  let fired = 0;
  try {
    if (env.DEMO_MODE && env.DEMO_CLOCK !== 'off') {
      // Auto: compress only while a confirmed pickup is waiting on its clocks.
      compress(manualCompression() || (await pendingSlotClocks()));
    }
    const due = await q<Clock>('select * from clocks where done_at is null and due_at <= $1 order by due_at limit 25', [now()]);
    for (const c of due) {
      await q('update clocks set done_at = $2 where id = $1', [c.id, now()]);
      try {
        await handlers[c.kind]?.(c);
        fired++;
      } catch (err) {
        console.error(`[clock] ${c.kind} failed:`, err);
      }
      if (c.kind === 'remind_buyer' && isCompressing() && !manualCompression()) {
        // Give the buyer real seconds to answer the reminder before time runs on.
        rewindTo(c.due_at.getTime());
        holdRealtime(HOLD_MS, () => true);
        break;
      }
    }
  } finally {
    ticking = false;
  }
  return fired;
}

async function ensureDigestClock(): Promise<void> {
  if (env.DEMO_MODE) return; // in demo mode the digest is the operator command "digest"
  const open = await q1("select id from clocks where kind = 'digest' and done_at is null limit 1");
  if (open) return;
  const t = now();
  const next = new Date(t.getFullYear(), t.getMonth(), t.getDate(), 19, 0);
  if (next.getTime() <= t.getTime()) next.setDate(next.getDate() + 1);
  await addClock('digest', next, {});
}

export async function startScheduler(): Promise<NodeJS.Timeout> {
  // Virtual time never starts behind what the database has already recorded.
  const latest = await q1<{ t: Date | null }>('select max(created_at) as t from messages');
  if (env.DEMO_MODE && latest?.t) startAt(latest.t.getTime());
  await ensureDigestClock();
  return setInterval(() => void tick().catch((err) => console.error('[clock] tick failed:', err)), env.DEMO_MODE ? 500 : 5_000);
}

export type { Item };
