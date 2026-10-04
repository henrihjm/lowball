// pnpm --filter @lowball/api exec tsx src/demo/try-items.ts
// Runs the photo pipeline on real photos of random things from Wikimedia Commons:
// identify -> comps -> price -> ad -> marketplaces. Each lands on the listings page with its photo.
// The items get a simulated inbox, so they never take mail away from a real listing.
import { json, q } from '../db/client.js';
import { addClock, getItem } from '../db/repo.js';
import { identify } from '../mastra/agents/identifier.js';
import { researchChannels } from '../mastra/workflows/channels.js';
import { draftItem } from '../mastra/workflows/listItem.js';
import { dollars } from '../policy/pricing.js';
import { DAY_MS, now, realNowMs } from './clock.js';

const SEARCHES = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['Eames lounge chair', 'Billy bookcase IKEA', 'road bicycle Trek', 'Fender Stratocaster guitar', 'KitchenAid stand mixer', 'mid-century teak sideboard'];
const UA = { 'user-agent': 'LowballHackathonTest/0.1 (github.com/henrihjm/lowball)' };

async function findPhoto(term: string): Promise<{ url: string; page: string } | undefined> {
  const api = `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=8&gsrsearch=${encodeURIComponent(`${term} filetype:bitmap`)}&prop=imageinfo&iiprop=url|mime&iiurlwidth=900`;
  const data = (await (await fetch(api, { headers: UA })).json()) as { query?: { pages?: Record<string, { index: number; imageinfo?: { thumburl: string; descriptionurl: string; mime: string }[] }> } };
  const pages = Object.values(data.query?.pages ?? {}).sort((a, b) => a.index - b.index);
  const hit = pages.map((p) => p.imageinfo?.[0]).find((i) => i && i.mime === 'image/jpeg');
  return hit ? { url: hit.thumburl, page: hit.descriptionurl } : undefined;
}

for (const term of SEARCHES) {
  const started = realNowMs();
  try {
    const photo = await findPhoto(term);
    if (!photo) {
      console.log(`${term}: no photo found`);
      continue;
    }
    const bytes = Buffer.from(await (await fetch(photo.url, { headers: UA })).arrayBuffer());
    const base64 = bytes.toString('base64');
    // No caption: the agent only gets the photo, the way it would from a phone.
    const id = await identify([{ base64, mime: 'image/jpeg' }], null);
    if (!id) {
      console.log(`${term}: could not identify the photo (${photo.page})`);
      continue;
    }
    const card = await draftItem({ title: id.title, condition: id.condition, notes: id.notes, searchQuery: id.search_query });
    const at = now();
    await q("update items set status = 'listed', listed_at = $2, inbox_id = $3, inbox_address = $4, photos = $5::jsonb where id = $1", [
      card.itemId,
      at,
      `try-${card.itemId.slice(0, 8)}`,
      `try-${card.itemId.slice(0, 8)}@sim.lowball`,
      json([{ data: base64, mime: 'image/jpeg' }]),
    ]);
    await addClock('decay', new Date(at.getTime() + 3 * DAY_MS), { item_id: card.itemId });
    const channels = await researchChannels(card.itemId);
    const item = (await getItem(card.itemId))!;
    const real = (item.comps ?? []).filter((c) => c.source !== 'estimate');
    console.log(
      `\n[${term}] ${((realNowMs() - started) / 1000).toFixed(0)}s\n  saw:      ${item.title} (${item.condition_notes})${id.confident === false ? '  [not confident]' : ''}\n  price:    ask ${dollars(item.ask_cents)}, floor ${dollars(item.floor_cents)} from ${real.length} comps${real.length < 3 ? ' + estimate' : ` (${dollars(Math.min(...real.map((c) => c.price_cents)))} to ${dollars(Math.max(...real.map((c) => c.price_cents)))})`}\n  ad:       ${item.description}\n  sell on:  ${channels.map((c) => c.name).join(', ')}\n  photo:    ${photo.page}`,
    );
  } catch (err) {
    console.log(`${term}: failed: ${(err as Error).message}`);
  }
}
process.exit(0);
