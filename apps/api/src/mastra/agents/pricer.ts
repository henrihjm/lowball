// The pricer reads prices out of Exa highlights. It never invents a comp:
// code keeps only prices that literally appear in the source text, then does the math.
import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import type { Comp } from '../../db/repo.js';
import { extractDollarAmounts } from '../../policy/negotiation.js';
import { gatewayModel, generateJson } from '../model.js';
import { exaComps, searchComps, type RawComp } from '../tools/exaComps.js';

export const pricer = new Agent({
  id: 'pricer',
  name: 'Pricer',
  instructions: `You extract prices of used items from search result snippets.
You get an item name and numbered results (title, source, snippets).
For each result that shows a price for the same item (same brand and model, used or sold, not new retail, not parts, not a different model), output one entry.
Use only a price that appears in that result's text. Never estimate. Skip results with no price.
Reply with only JSON: {"comps": [{"index": number, "price_dollars": number}]}`,
  model: () => gatewayModel('text'),
  tools: { exaComps },
});

const schema = z.object({ comps: z.array(z.object({ index: z.number().int(), price_dollars: z.number().positive() })) });

const textOf = (r: RawComp) => `${r.title}\n${r.highlights.join('\n')}`;

/** Every price the model reports must literally appear in the result it cites. */
export function keepVerified(raw: RawComp[], picked: { index: number; price_dollars: number }[]): Comp[] {
  const out: Comp[] = [];
  const seen = new Set<string>();
  for (const p of picked) {
    const r = raw[p.index];
    if (!r || seen.has(r.url)) continue;
    const cents = Math.round(p.price_dollars * 100);
    if (!extractDollarAmounts(textOf(r)).includes(cents)) continue;
    seen.add(r.url);
    out.push({ title: r.title.slice(0, 140), price_cents: cents, url: r.url, source: r.source });
  }
  return out;
}

/** No model available: take the first plausible dollar amount in each result. */
export function ruleComps(raw: RawComp[]): Comp[] {
  const out: Comp[] = [];
  for (const r of raw) {
    const price = extractDollarAmounts(textOf(r)).find((c) => c >= 500 && c <= 2_000_000);
    if (price) out.push({ title: r.title.slice(0, 140), price_cents: price, url: r.url, source: r.source });
  }
  return out;
}

async function extract(itemName: string, raw: RawComp[]): Promise<Comp[]> {
  if (raw.length === 0) return [];
  const listing = raw.map((r, i) => `[${i}] ${r.title} (${r.source})\n${r.highlights.join(' | ').slice(0, 700)}`).join('\n\n');
  const out = await generateJson(pricer, `ITEM: ${itemName}\n\nRESULTS:\n${listing}`, schema, 'pricer', 20_000);
  return out ? keepVerified(raw, out.comps) : ruleComps(raw);
}

/** Marketplaces first. If that is thin, a second, wider search before giving up on real comps. */
export async function findComps(itemName: string): Promise<Comp[]> {
  const comps = await extract(itemName, await searchComps(itemName));
  if (comps.length >= 3) return comps;
  const wide = await extract(itemName, await searchComps(itemName, true).catch(() => []));
  const seen = new Set(comps.map((c) => c.url));
  return [...comps, ...wide.filter((c) => !seen.has(c.url))];
}

const estimateSchema = z.object({ typical_used_dollars: z.number().positive(), basis: z.string() });

/**
 * Last resort when research finds fewer than 3 real comps: the model's estimate of the typical
 * used price, so Henri is never asked. The basis is stored with the item and shown as an estimate.
 */
export async function estimateUsedPrice(itemName: string, condition: string | null | undefined, found: Comp[]): Promise<{ cents: number; basis: string } | undefined> {
  const out = await generateJson(
    pricer,
    `No search results to parse this time. Estimate instead.\nITEM: ${itemName}\nCONDITION: ${condition ?? 'used, as pictured'}\nPRICES FOUND SO FAR: ${found.map((c) => `$${c.price_cents / 100}`).join(', ') || 'none'}\n\nEstimate what this typically sells for used, locally, between private people. Be conservative.\nReply with only JSON: {"typical_used_dollars": number, "basis": "one short sentence on what the estimate rests on"}`,
    estimateSchema,
    'estimate',
    20_000,
  );
  return out ? { cents: Math.round(out.typical_used_dollars * 100), basis: out.basis.slice(0, 200) } : undefined;
}
