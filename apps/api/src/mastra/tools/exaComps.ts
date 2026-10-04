// exaComps: sold or listed comparables for an item, through Exa search.
import { createTool } from '@mastra/core/tools';
import Exa from 'exa-js';
import { z } from 'zod';
import { env } from '../../env.js';

export const COMP_DOMAINS = ['ebay.com', 'craigslist.org', 'reverb.com', 'offerup.com', 'mercari.com'];

export interface RawComp {
  title: string;
  url: string;
  source: string;
  highlights: string[];
}

let exa: Exa | undefined;

export async function searchComps(itemName: string): Promise<RawComp[]> {
  if (!env.EXA_API_KEY) return [];
  exa ??= new Exa(env.EXA_API_KEY);
  const res = await exa.search(`${itemName} used sold price`, {
    numResults: 15,
    type: 'fast',
    contents: { highlights: true },
    includeDomains: COMP_DOMAINS,
  });
  return res.results.map((r) => ({
    title: r.title ?? '',
    url: r.url,
    source: new URL(r.url).hostname.replace(/^www\./, ''),
    highlights: ((r as { highlights?: string[] }).highlights ?? []).map((h) => h.slice(0, 600)),
  }));
}

export const exaComps = createTool({
  id: 'exaComps',
  description: 'Search eBay, Craigslist, Reverb, OfferUp and Mercari for sold or listed prices of a used item. Returns titles, URLs and text highlights.',
  inputSchema: z.object({ item: z.string().describe('Brand and model, e.g. "Herman Miller Sayl chair"') }),
  outputSchema: z.object({ results: z.array(z.object({ title: z.string(), url: z.string(), source: z.string(), highlights: z.array(z.string()) })) }),
  execute: async (input) => ({ results: await searchComps(input.item) }),
});
