// The board's view of the world. One call, polled every 2 seconds.
import { q, q1 } from './db/client.js';
import { firstName, type Buyer, type Item, type Message, type Slot } from './db/repo.js';
import { clockInfo } from './demo/clock.js';
import { env } from './env.js';
import { itemStats } from './mastra/workflows/lifecycle.js';
import { queueDepth } from './mastra/workflows/handleInbound.js';
import { sentToOwner } from './telegram/notify.js';

/** The board is shown to a room. Buyer addresses are masked. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const head = local.slice(0, Math.min(2, Math.max(1, local.length - 1)));
  return `${head}${'*'.repeat(Math.max(2, Math.min(6, local.length - head.length)))}@${domain}`;
}

export async function boardState(itemId?: string) {
  const items = await q<Item>("select * from items where status <> 'deleted' order by coalesce(listed_at, created_at) desc limit 20");
  const item = (itemId ? items.find((i) => i.id === itemId) : undefined) ?? items.find((i) => ['listed', 'pending'].includes(i.status)) ?? items[0];
  const base = {
    clock: clockInfo(),
    demoMode: env.DEMO_MODE,
    queue: queueDepth(),
    items: items.map((i) => ({ id: i.id, title: i.title, status: i.status })),
    telegram: sentToOwner.slice(-6).reverse(),
  };
  if (!item) return { ...base, item: null, buyers: [], threads: [] };

  const buyers = await q<Buyer>('select * from buyers where item_id = $1 order by score desc, last_inbound desc nulls last', [item.id]);
  const messages = await q<Message & { item_id: string }>(
    `select m.* from messages m join buyers b on b.id = m.buyer_id where b.item_id = $1 order by m.created_at desc limit 400`,
    [item.id],
  );
  const slot = await q1<Slot>("select * from slots where item_id = $1 and status in ('confirmed','address_sent','reminded','completed') order by starts_at desc limit 1", [item.id]);
  const nextDecay = await q1<{ due_at: Date }>("select due_at from clocks where kind = 'decay' and done_at is null and payload->>'item_id' = $1 order by due_at limit 1", [item.id]);
  const slotBuyer = slot ? buyers.find((b) => b.id === slot.buyer_id) : undefined;

  const byBuyer = new Map<string, typeof messages>();
  for (const m of messages) {
    const list = byBuyer.get(m.buyer_id) ?? [];
    list.push(m);
    byBuyer.set(m.buyer_id, list);
  }
  const threads = buyers
    .filter((b) => byBuyer.has(b.id))
    .map((b) => {
      const list = byBuyer.get(b.id)!;
      return {
        buyerId: b.id,
        name: firstName(b),
        email: maskEmail(b.email),
        status: b.status,
        scamFlags: b.scam_flags ?? [],
        lastAt: list[0]!.created_at,
        messages: list
          .slice(0, 12)
          .reverse()
          .map((m) => ({
            id: m.id,
            direction: m.direction,
            body: m.body,
            intent: m.intent,
            reasoning: m.reasoning,
            offerCents: m.offer_cents,
            floorCents: m.floor_at_time_cents,
            askCents: m.ask_at_time_cents,
            at: m.created_at,
          })),
      };
    })
    .sort((a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime());

  return {
    ...base,
    item: {
      id: item.id,
      title: item.title,
      status: item.status,
      description: item.description,
      askCents: item.ask_cents,
      floorCents: item.floor_cents,
      decayPct: Number(item.decay_pct),
      decayEveryDays: item.decay_every_days,
      nextDecayAt: nextDecay?.due_at ?? null,
      listedAt: item.listed_at,
      soldCents: item.sold_cents,
      inboxAddress: item.inbox_address,
      craigslistUrl: item.craigslist_url,
      kernelLiveViewUrl: item.kernel_live_view_url,
      hasPhoto: Boolean(item.photos?.length),
      stats: await itemStats(item.id),
      slot: slot
        ? {
            startsAt: slot.starts_at,
            status: slot.status,
            buyerName: slotBuyer ? firstName(slotBuyer) : null,
            agreedCents: slotBuyer?.agreed_cents ?? null,
            addressAt: new Date(slot.starts_at.getTime() - 2 * 3_600_000),
            addressSentAt: slot.address_sent_at,
          }
        : null,
    },
    buyers: buyers.map((b) => ({
      id: b.id,
      name: firstName(b),
      email: maskEmail(b.email),
      status: b.status,
      score: Number(b.score),
      lastOfferCents: b.last_offer_cents,
      agreedCents: b.agreed_cents,
      countersUsed: b.counters_used,
      proposedTime: b.proposed_time,
      scamFlags: b.scam_flags ?? [],
    })),
    threads,
  };
}

export type BoardState = Awaited<ReturnType<typeof boardState>>;
