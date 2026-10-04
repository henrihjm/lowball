// Where to sell this item. Researched per item: the 3 to 5 marketplaces where it is most
// likely to be bought, from where comparable listings were actually found plus the model's
// knowledge of niche marketplaces. One ad, tracked across all of them, closed everywhere on a sale.
import { z } from 'zod';
import { json, q } from '../../db/client.js';
import { getItem, type Comp } from '../../db/repo.js';
import { pricer } from '../agents/pricer.js';
import { generateJson } from '../model.js';

export interface Channel {
  name: string;
  url: string;
  why: string;
  status: 'ready' | 'live' | 'sold';
}

const KNOWN: Record<string, { name: string; url: string }> = {
  'craigslist.org': { name: 'Craigslist', url: 'https://post.craigslist.org/c/sfo' },
  'ebay.com': { name: 'eBay', url: 'https://www.ebay.com/sl/sell' },
  'offerup.com': { name: 'OfferUp', url: 'https://offerup.com/post' },
  'mercari.com': { name: 'Mercari', url: 'https://www.mercari.com/sell/' },
  'reverb.com': { name: 'Reverb', url: 'https://reverb.com/my/selling/listings/new' },
  'facebook.com': { name: 'Facebook Marketplace', url: 'https://www.facebook.com/marketplace/create/item' },
};

const schema = z.object({
  channels: z.array(z.object({ name: z.string().min(2).max(40), post_url: z.string().url(), why: z.string().max(140) })).min(3).max(5),
});

/** No model: rank the marketplaces where comps were found, then the two general local ones. */
export function ruleChannels(comps: Comp[]): Channel[] {
  const counts = new Map<string, number>();
  for (const c of comps) {
    const key = Object.keys(KNOWN).find((d) => c.source.endsWith(d));
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([d, n]) => ({ ...KNOWN[d]!, why: `${n} comparable listing${n === 1 ? '' : 's'} found here`, status: 'ready' as const }));
  for (const d of ['craigslist.org', 'facebook.com', 'offerup.com']) {
    if (ranked.length >= 4) break;
    if (!ranked.some((r) => r.name === KNOWN[d]!.name)) ranked.push({ ...KNOWN[d]!, why: 'Large local pickup audience', status: 'ready' });
  }
  return ranked.slice(0, 5);
}

export async function researchChannels(itemId: string): Promise<Channel[]> {
  const item = await getItem(itemId);
  if (!item) return [];
  const comps = (item.comps ?? []).filter((c) => c.source !== 'estimate');
  const found = ruleChannels(comps);
  const out = await generateJson(
    pricer,
    `No prices to extract this time. Choose marketplaces instead.
ITEM: ${item.title}${item.condition_notes ? ` (${item.condition_notes})` : ''}, asking $${(item.ask_cents ?? 0) / 100}, local pickup in San Francisco.
WHERE COMPARABLE LISTINGS WERE FOUND: ${found.map((f) => `${f.name} (${f.why})`).join('; ') || 'none'}

Pick the 3 to 5 places where this exact kind of item is most likely to be bought, best first. Include a category-specific marketplace when a strong one exists (for example Reverb for instruments, Chairish or AptDeco for design furniture, Poshmark for clothing, Swappa for phones, BackMarket-style sites are for dealers and do not count). Prefer places where a private person can post for free and sell locally.
Reply with only JSON: {"channels": [{"name": string, "post_url": "the URL where a seller starts a new listing", "why": "under 12 words, specific to this item"}]}`,
    schema,
    'channels',
    20_000,
  );
  const channels: Channel[] = out
    ? out.channels.map((c) => {
        const known = Object.values(KNOWN).find((k) => k.name.toLowerCase() === c.name.toLowerCase());
        return { name: known?.name ?? c.name, url: known?.url ?? c.post_url, why: c.why.replace(/[—–]/g, ','), status: 'ready' as const };
      })
    : found;
  await q('update items set channels = $2::jsonb where id = $1', [itemId, json(channels)]);
  return channels;
}

/** Henri (or an automated poster) confirms the ad is up on a channel. */
export async function setChannelStatus(itemId: string, name: string, status: Channel['status']): Promise<void> {
  const item = await getItem(itemId);
  const channels = ((item as unknown as { channels?: Channel[] })?.channels ?? []).map((c) => (c.name === name ? { ...c, status } : c));
  await q('update items set channels = $2::jsonb where id = $1', [itemId, json(channels)]);
}

/** A sale on one platform closes the ad on all of them. Returns the channels that were live. */
export async function closeChannels(itemId: string): Promise<Channel[]> {
  const item = await getItem(itemId);
  const channels = (item as unknown as { channels?: Channel[] })?.channels ?? [];
  const wasLive = channels.filter((c) => c.status === 'live');
  await q('update items set channels = $2::jsonb where id = $1', [itemId, json(channels.map((c) => ({ ...c, status: 'sold' })))]);
  return wasLive;
}
