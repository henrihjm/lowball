// What happens when Henri taps a button on a Telegram interrupt.
import { q, q1 } from '../../db/client.js';
import { firstName, getBuyer, getItem, type DecisionRow, type Slot } from '../../db/repo.js';
import { now } from '../../demo/clock.js';
import { dollars } from '../../policy/pricing.js';
import { formatSlot, formatSlotLong, parseWindows, upcomingSlots } from '../../policy/windows.js';
import { getUser } from '../../db/repo.js';
import { acceptOfferCore } from '../tools/acceptOffer.js';
import { blockBuyerCore } from '../tools/blockBuyer.js';
import { scheduleSlotCore, sendToBuyer } from '../tools/scheduleSlot.js';
import { respond } from './handleInbound.js';
import { handleNoShow, markSold, promoteBackup, relist } from './lifecycle.js';

export interface Resolution {
  /** One line confirming the action, shown to Henri. */
  text: string;
  /** Set when the bot should wait for a typed amount ("Different amount"). */
  awaitAmountForItem?: string;
}

async function slotLines(userId: string): Promise<string> {
  const user = await getUser(userId);
  const slots = upcomingSlots(parseWindows(user.pickup_windows), now(), 3).map(formatSlot);
  return slots.length > 0 ? `I can do ${slots.join(', ')}. Which works?` : 'When could you pick up?';
}

export async function resolveDecision(decisionId: string, key: string): Promise<Resolution> {
  // Claim it atomically so a double tap cannot act twice.
  const d = await q1<DecisionRow>('update decisions set chosen = $2, resolved_at = $3 where id = $1 and resolved_at is null returning *', [decisionId, key, now()]);
  if (!d) return { text: 'Already handled.' };
  const option = d.options?.find((o) => o.key === key);
  if (!option) return { text: 'Unknown option.' };
  const buyer = d.buyer_id ? await getBuyer(d.buyer_id) : undefined;
  const item = d.item_id ? await getItem(d.item_id) : undefined;
  const name = buyer ? firstName(buyer) : 'Buyer';

  switch (d.kind) {
    case 'below_floor': {
      if (!buyer || !item) break;
      if (key === 'take_it') {
        const offer = Number(d.payload?.offer_cents);
        const res = await acceptOfferCore(buyer.id, offer);
        if (!res.ok) return { text: `Could not accept: ${res.reason}.` };
        await sendToBuyer(buyer, `${dollars(offer)} works. ${await slotLines(item.user_id)}`, 'accept_needs_time', `Henri approved ${dollars(offer)} on Telegram, below the floor. Accepted through acceptOffer.`);
        return { text: `Taking ${dollars(offer)} from ${name}. Asked them to pick a slot.` };
      }
      if (key === 'counter_mid') {
        const mid = Number(d.payload?.mid_cents);
        await q('update buyers set last_counter_cents = $2 where id = $1', [buyer.id, mid]);
        await sendToBuyer(buyer, `I can do ${dollars(mid)}. That's final. ${await slotLines(item.user_id)}`, 'counter_final', `Henri approved a counter at ${dollars(mid)} on Telegram, below the floor.`);
        return { text: `Countered ${name} at ${dollars(mid)}.` };
      }
      return { text: `Holding the floor at ${dollars(item.floor_cents)}.` };
    }
    case 'slot_conflict': {
      if (!buyer || !item) break;
      const when = new Date(String(d.payload?.starts_at));
      if (key === 'allow') {
        const res = await scheduleSlotCore(buyer.id, when, { allowOutsideWindows: true });
        if (!res.ok) return { text: `Could not book ${formatSlotLong(when)}: ${res.reason}.` };
        await sendToBuyer(buyer, `${formatSlotLong(when)} works. You're confirmed. I'll send the exact address two hours before pickup.`, 'slot_confirmed', 'Henri allowed a pickup outside the usual windows. Slot confirmed.');
        return { text: `Booked ${name} for ${formatSlotLong(when)}.` };
      }
      await sendToBuyer(buyer, `That time doesn't work. ${await slotLines(item.user_id)}`, 'schedule', 'Henri declined the time outside the pickup windows. Offering the usual slots.');
      return { text: `Declined. Offered ${name} the usual slots.` };
    }
    case 'scam_unsure': {
      if (!buyer) break;
      if (key === 'block') {
        await blockBuyerCore(buyer.id, [{ rule: 'henri_blocked', label: String(d.payload?.reason ?? 'blocked by Henri') }]);
        return { text: `Blocked ${name}.` };
      }
      if (d.payload?.message_id) await respond(buyer.id, String(d.payload.message_id), { bypassSuspicious: true });
      return { text: `OK. Answered ${name}.` };
    }
    case 'noshow': {
      if (!item) break;
      const slot = await q1<Slot>('select * from slots where id = $1', [d.payload?.slot_id]);
      if (key === 'wait') return { text: 'Waiting.' };
      if (key === 'switch_backup') {
        if (slot && ['confirmed', 'address_sent', 'reminded'].includes(slot.status)) return { text: await handleNoShow(slot, { promote: true }) };
        const promoted = await promoteBackup(item.id);
        return { text: promoted ? `Switched to the backup (${firstName(promoted)}).` : 'No backup in the queue.' };
      }
      await relist(item.id);
      return { text: `Relisted at ${dollars(item.ask_cents)}.` };
    }
    case 'sold_check': {
      if (!item) break;
      if (key === 'sold') return { text: await markSold(item.id, Number(d.payload?.cents ?? item.ask_cents)) };
      if (key === 'different') return { text: 'What did it sell for? Send the amount.', awaitAmountForItem: item.id };
      const slot = await q1<Slot>('select * from slots where id = $1', [d.payload?.slot_id]);
      if (slot) return { text: await handleNoShow(slot, { promote: true }) };
      return { text: 'Marked as a no-show.' };
    }
  }
  return { text: `${option.label}.` };
}
