// listItem: identify -> price -> draft -> (post).
import { json, q, q1 } from '../../db/client.js';
import { getItem, getUser, type Comp, type Item } from '../../db/repo.js';
import { now } from '../../demo/clock.js';
import { dollars, parseFloorFromCaption, proposePrice, roundTo5 } from '../../policy/pricing.js';
import * as tpl from '../../telegram/templates.js';
import type { Button } from '../../telegram/notify.js';
import { identify, type Photo } from '../agents/identifier.js';
import { findComps } from '../agents/pricer.js';

export interface Card {
  itemId: string;
  text: string;
  buttons: Button[];
  /** True when there were too few comps and Henri has to name the price. */
  needsPrice: boolean;
}

const sentence = (s: string) => {
  const t = s.trim().replace(/[—–]/g, ',').replace(/\s+/g, ' ');
  return t ? (/[.!?]$/.test(t) ? t : `${t}.`) : '';
};
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** Short, specific, honest. Brand, model, year, condition with any defect, pickup, price. */
export function listingCopy(p: { title: string; condition?: string | null; notes?: string | null; neighborhood?: string | null; windows?: string | null; askCents?: number | null }): string {
  const parts = [sentence(p.title)];
  if (p.notes) parts.push(sentence(p.notes));
  if (p.condition) parts.push(sentence(cap(p.condition)));
  const pickup = [p.neighborhood, p.windows].filter(Boolean).join(', ');
  if (pickup) parts.push(`Pickup ${pickup}.`);
  if (p.askCents != null) parts.push(`${dollars(p.askCents)}.`);
  return parts.filter(Boolean).join(' ');
}

export async function cardFor(itemId: string): Promise<Card> {
  const item = (await getItem(itemId))!;
  const user = await getUser(item.user_id);
  const comps = item.comps ?? [];
  const prices = comps.map((c) => c.price_cents);
  const conditionLine = item.condition_notes || 'condition as pictured';
  if (item.ask_cents == null || item.floor_cents == null) {
    return { itemId, text: tpl.needsPriceCard(item.title ?? 'Item', conditionLine, comps.length), buttons: [], needsPrice: true };
  }
  const text = tpl.proposalCard({
    title: item.title ?? 'Item',
    conditionLine,
    loCents: prices.length > 0 ? Math.min(...prices) : item.floor_cents,
    hiCents: prices.length > 0 ? Math.max(...prices) : item.ask_cents,
    n: comps.length,
    askCents: item.ask_cents,
    floorCents: item.floor_cents,
    decayPct: Number(item.decay_pct),
    decayEveryDays: item.decay_every_days,
    windows: user.pickup_windows ?? 'time to be agreed',
    neighborhood: user.neighborhood ?? 'local pickup',
    listing: item.description ?? '',
  });
  return { itemId, text, buttons: tpl.proposalButtons(itemId), needsPrice: false };
}

async function redraft(itemId: string): Promise<void> {
  const item = (await getItem(itemId))!;
  const user = await getUser(item.user_id);
  const copy = listingCopy({ title: item.title ?? 'Item', condition: item.condition_notes, neighborhood: user.neighborhood, windows: user.pickup_windows, askCents: item.ask_cents });
  await q('update items set description = $2 where id = $1', [itemId, copy]);
}

export interface DraftInput {
  title: string;
  condition?: string | null;
  notes?: string | null;
  searchQuery?: string | null;
  floorOverrideCents?: number;
  telegramFileIds?: string[];
}

/** Price from comps and store a draft. Nothing is live until Henri taps Post. */
export async function draftItem(d: DraftInput): Promise<Card> {
  let comps: Comp[] = [];
  try {
    comps = await findComps(d.searchQuery || d.title);
  } catch (err) {
    console.warn('[list] comps search failed:', (err as Error).message);
  }
  const price = proposePrice(comps.map((c) => c.price_cents), d.floorOverrideCents);
  // Keep only the comps that survived the outlier filter, so the card's range matches the math.
  const kept = price.ok ? comps.filter((c) => c.price_cents >= price.loCents && c.price_cents <= price.hiCents) : comps;

  const user = await getUser();
  const photos = (d.telegramFileIds ?? []).map((f) => ({ telegram_file_id: f }));
  const row = (await q1<{ id: string }>(
    `insert into items (user_id, status, title, condition_notes, photos, ask_cents, floor_cents, comps, created_at)
     values ('henri', 'draft', $1, $2, $3::jsonb, $4, $5, $6::jsonb, $7) returning id`,
    [d.title, d.condition ?? null, json(photos), price.ok ? price.askCents : null, price.ok ? price.floorCents : null, json(kept), now()],
  ))!;
  const copy = listingCopy({ title: d.title, notes: d.notes, condition: d.condition, neighborhood: user.neighborhood, windows: user.pickup_windows, askCents: price.ok ? price.askCents : null });
  await q('update items set description = $2 where id = $1', [row.id, copy]);
  return cardFor(row.id);
}

/** Photo in, proposal card out. Creates a draft item. */
export async function listItem(input: { photos: Photo[]; telegramFileIds: string[]; caption?: string | null }): Promise<Card | { error: string }> {
  const id = await identify(input.photos, input.caption);
  const title = id?.title ?? input.caption?.split(/[.\n]/)[0]?.replace(/\bfloor\s*\$?\d+/i, '').trim();
  if (!title) {
    return { error: "I couldn't tell what this is from the photo. Send it again with a caption, e.g. \"Herman Miller Sayl chair, 2019, one arm loose\"." };
  }
  return draftItem({
    title,
    condition: id?.condition,
    notes: id?.notes,
    searchQuery: id?.search_query,
    floorOverrideCents: parseFloorFromCaption(input.caption),
    telegramFileIds: input.telegramFileIds,
  });
}

/** "220 floor 160", "ask 200", "floor 150". Returns an error line when the numbers do not make sense. */
export async function setPrice(itemId: string, text: string): Promise<string | undefined> {
  const item = (await getItem(itemId))!;
  const floorM = text.match(/\bfloor\s*:?\s*\$?\s*(\d{1,6})\b/i);
  const askM = text.replace(/\bfloor\s*:?\s*\$?\s*\d{1,6}\b/i, ' ').match(/\$?\s*(\d{1,6})\b/);
  const ask = askM ? parseInt(askM[1]!, 10) * 100 : item.ask_cents;
  let floor = floorM ? parseInt(floorM[1]!, 10) * 100 : item.floor_cents;
  if (ask == null) return 'Send a price, e.g. "220 floor 160".';
  floor ??= roundTo5(ask * 0.75);
  if (floor > ask) return `The floor (${dollars(floor)}) can't be above the ask (${dollars(ask)}).`;
  const oldAsk = item.ask_cents;
  await q('update items set ask_cents = $2, floor_cents = $3 where id = $1', [itemId, ask, floor]);
  // Keep the price in the listing copy in step with the ask.
  if (item.description && oldAsk != null && item.description.includes(dollars(oldAsk))) {
    await q('update items set description = $2 where id = $1', [itemId, item.description.replace(dollars(oldAsk), dollars(ask))]);
  } else if (item.description && oldAsk == null) {
    await q('update items set description = $2 where id = $1', [itemId, `${item.description} ${dollars(ask)}.`]);
  } else if (!item.description) {
    await redraft(itemId);
  }
  return undefined;
}

export async function setListingText(itemId: string, text: string): Promise<void> {
  await q('update items set description = $2 where id = $1', [itemId, text.trim().replace(/[—–]/g, ',')]);
}

export type { Item };
