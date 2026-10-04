// acceptOffer: the only way an offer becomes accepted. Validated in code:
// offer >= floor, or Henri approved a below-floor price for this buyer on Telegram.
// The model cannot accept by writing words.
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { q, q1 } from '../../db/client.js';
import { getBuyer, getItem } from '../../db/repo.js';
import { canAccept } from '../../policy/negotiation.js';
import { dollars } from '../../policy/pricing.js';

/** Lowest price Henri approved for this buyer through a below_floor decision, if any. */
export async function approvedCents(buyerId: string): Promise<number | undefined> {
  const row = await q1<{ cents: number | null }>(
    `select min(case chosen when 'take_it' then (payload->>'offer_cents')::int when 'counter_mid' then (payload->>'mid_cents')::int end) as cents
     from decisions where buyer_id = $1 and kind = 'below_floor' and chosen in ('take_it','counter_mid')`,
    [buyerId],
  );
  return row?.cents ?? undefined;
}

export type AcceptResult = { ok: true; agreedCents: number } | { ok: false; reason: string };

export async function acceptOfferCore(buyerId: string, offerCents: number): Promise<AcceptResult> {
  const buyer = await getBuyer(buyerId);
  if (!buyer) return { ok: false, reason: 'unknown buyer' };
  const item = await getItem(buyer.item_id);
  if (!item || item.floor_cents == null) return { ok: false, reason: 'item has no floor' };
  if (buyer.status === 'blocked') return { ok: false, reason: 'buyer is blocked' };
  if (!Number.isInteger(offerCents) || offerCents <= 0) return { ok: false, reason: 'invalid amount' };

  const approved = await approvedCents(buyerId);
  const approvedForThis = approved != null && offerCents >= approved;
  if (!canAccept(offerCents, item.floor_cents, approvedForThis)) {
    return { ok: false, reason: `refused: ${dollars(offerCents)} is below the floor and Henri has not approved it` };
  }
  // Only a number that is actually on the table can be accepted.
  const onTable = [buyer.last_offer_cents, buyer.last_counter_cents, buyer.agreed_cents, item.ask_cents].filter((v): v is number => v != null);
  if (!onTable.includes(offerCents)) return { ok: false, reason: `refused: ${dollars(offerCents)} was never offered in this thread` };

  await q('update buyers set agreed_cents = $2 where id = $1', [buyerId, offerCents]);
  return { ok: true, agreedCents: offerCents };
}

export const acceptOffer = createTool({
  id: 'acceptOffer',
  description:
    'Accept a buyer offer, conditional on a pickup slot. Validated in code against the floor price. Refuses anything below the floor unless Henri approved it. Writing "deal" in a reply without a successful acceptOffer accepts nothing.',
  inputSchema: z.object({ buyer_id: z.string(), offer_cents: z.number().int() }),
  outputSchema: z.object({ ok: z.boolean(), agreed_cents: z.number().optional(), reason: z.string().optional() }),
  execute: async (input) => {
    const res = await acceptOfferCore(input.buyer_id, input.offer_cents);
    return res.ok ? { ok: true, agreed_cents: res.agreedCents } : { ok: false, reason: res.reason };
  },
});
