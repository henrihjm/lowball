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

export async function findComps(itemName: string): Promise<Comp[]> {
  const raw = await searchComps(itemName);
  if (raw.length === 0) return [];
  const listing = raw.map((r, i) => `[${i}] ${r.title} (${r.source})\n${r.highlights.join(' | ').slice(0, 700)}`).join('\n\n');
  const out = await generateJson(pricer, `ITEM: ${itemName}\n\nRESULTS:\n${listing}`, schema, 'pricer', 20_000);
  return out ? keepVerified(raw, out.comps) : ruleComps(raw);
}
