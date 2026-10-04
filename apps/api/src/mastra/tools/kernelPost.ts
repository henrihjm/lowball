// kernelPost: fills in the Craigslist posting form through a Kernel cloud browser.
// EXPERIMENTAL and off by default (KERNEL_POSTING=false). The browser's live view URL is
// stored on the item while it runs, so the board can embed it and Henri can watch or take over.
// When any step fails, the caller falls back to posting by hand; the inbox is the product.
import { createTool } from '@mastra/core/tools';
import Kernel from '@onkernel/sdk';
import { z } from 'zod';
import { q } from '../../db/client.js';
import { getItem, getUser } from '../../db/repo.js';
import { env } from '../../env.js';

export type KernelPostResult = { ok: true; step: string; liveViewUrl?: string } | { ok: false; reason: string; liveViewUrl?: string };

const START_URL = 'https://post.craigslist.org/c/sfo';

/** Runs inside the Kernel browser. `page` is a Playwright page; `data` is inlined as JSON. */
function postingScript(data: { title: string; price: number; body: string; email: string; neighborhood: string; neighborhoods: string[]; category: string }): string {
  return `
    const data = ${JSON.stringify(data)};
    const steps = [];
    // Each chooser page is a radio list plus a Continue button (button[name="go"]).
    const pick = async (label) => {
      await label.click();
      await page.waitForTimeout(250);
      const go = page.locator('button[name="go"]').first();
      if (await go.count() > 0) await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}), go.click()]);
      await page.waitForTimeout(600);
      return true;
    };
    const choose = async (re) => {
      const label = page.locator('label').filter({ hasText: re }).first();
      return (await label.count()) > 0 ? pick(label) : false;
    };
    const chooseExact = async (name) => {
      const labels = page.locator('label');
      const n = await labels.count();
      for (let i = 0; i < n; i++) {
        const text = ((await labels.nth(i).textContent()) || '').trim().toLowerCase();
        if (text === name) return pick(labels.nth(i));
      }
      return false;
    };
    await page.goto(${JSON.stringify(START_URL)}, { waitUntil: 'domcontentloaded' });
    // Craigslist asks in this order: sub-area, neighborhood, posting type, category, then the form.
    if (await choose(/city of san francisco/i)) steps.push('area');
    let hood = false;
    for (const name of data.neighborhoods) { if (await chooseExact(name)) { hood = true; break; } }
    if (hood || await choose(/bypass this step/i)) steps.push('neighborhood');
    if (await choose(/for sale by owner/i)) steps.push('type');
    if (await choose(data.category) || await choose('general for sale')) steps.push('category');

    const fill = async (selector, value) => {
      const el = page.locator(selector).first();
      if (await el.count() === 0) return false;
      await el.fill(String(value));
      return true;
    };
    const filled = [
      await fill('input[name="PostingTitle"]', data.title),
      await fill('input[name="price"]', data.price),
      await fill('textarea[name="PostingBody"]', data.body),
    ];
    await fill('input[name="geographic_area"]', data.neighborhood);
    await fill('input[name="FromEMail"]', data.email);
    await fill('input[name="ConfirmEMail"]', data.email);
    if (filled.every(Boolean)) steps.push('form');
    const labels = await page.$$eval('label', (ls) => ls.slice(0, 14).map((l) => (l.textContent || '').trim().slice(0, 40)));
    const fields = await page.$$eval('input:not([type=hidden]), textarea, select', (xs) => xs.slice(0, 30).map((x) => x.getAttribute('name')));
    return { steps, url: page.url(), title: await page.title(), labels, fields };
  `;
}

/** Craigslist's spelling of a neighborhood: "Pac Heights" is listed as "pacific heights". */
function neighborhoodNames(n?: string | null): string[] {
  if (!n) return [];
  const base = n.trim().toLowerCase();
  const long = base.replace(/\bpac\b/, 'pacific').replace(/\bhts\b/, 'heights');
  return [...new Set([base, long])];
}

export async function kernelPostCore(itemId: string): Promise<KernelPostResult> {
  if (!env.KERNEL_API_KEY) return { ok: false, reason: 'KERNEL_API_KEY is not set' };
  const item = await getItem(itemId);
  if (!item?.inbox_address || item.ask_cents == null) return { ok: false, reason: 'item is not ready to post' };
  const user = await getUser(item.user_id);

  const kernel = new Kernel({ apiKey: env.KERNEL_API_KEY });
  // Kept alive for 10 minutes so the form can be reviewed and submitted from the live view.
  const browser = await kernel.browsers.create({ stealth: true, timeout_seconds: 600 });
  const liveViewUrl = browser.browser_live_view_url;
  await q('update items set kernel_live_view_url = $2 where id = $1', [itemId, liveViewUrl ?? null]);

  try {
    const res = await kernel.browsers.playwright.execute(browser.session_id, {
      code: postingScript({
        title: (item.title ?? 'For sale').slice(0, 70),
        price: Math.round(item.ask_cents / 100),
        body: item.description ?? item.title ?? '',
        email: item.inbox_address,
        neighborhood: user.neighborhood ?? 'san francisco',
        neighborhoods: neighborhoodNames(user.neighborhood),
        category: /chair|table|desk|sofa|couch|shelf|dresser|bed|lamp/i.test(item.title ?? '') ? 'furniture' : 'general for sale',
      }),
      timeout_sec: 90,
    });
    if (!res.success) return { ok: false, reason: res.error ?? 'the browser script failed', liveViewUrl };
    const out = res.result as { steps?: string[]; url?: string; labels?: string[]; fields?: string[] } | undefined;
    console.log('[kernel] craigslist:', JSON.stringify(out).slice(0, 900));
    const steps = out?.steps ?? [];
    if (!steps.includes('form')) return { ok: false, reason: `stopped after "${steps.at(-1) ?? 'start'}" at ${out?.url ?? START_URL}`, liveViewUrl };
    // The form is filled in. Photos and the final submit happen in the live view; Craigslist then
    // mails a confirmation link to the item inbox, which arrives on the AgentMail webhook.
    return { ok: true, step: 'form', liveViewUrl };
  } catch (err) {
    await kernel.browsers.deleteByID(browser.session_id).catch(() => undefined);
    await q('update items set kernel_live_view_url = null where id = $1', [itemId]);
    return { ok: false, reason: (err as Error).message };
  }
}

export const kernelPost = createTool({
  id: 'kernelPost',
  description: 'Fill in the Craigslist posting form for an item through a Kernel cloud browser. Experimental.',
  inputSchema: z.object({ item_id: z.string() }),
  outputSchema: z.object({ ok: z.boolean(), reason: z.string().optional(), live_view_url: z.string().optional() }),
  execute: async (input) => {
    const res = await kernelPostCore(input.item_id);
    return { ok: res.ok, reason: res.ok ? undefined : res.reason, live_view_url: res.liveViewUrl };
  },
});
