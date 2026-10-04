// The owner's listings page: every item with its price, status and sales history.
// Read-only, server-rendered, behind an unguessable key in the URL (sent to Henri on Telegram).
import { createHash } from 'node:crypto';
import { q } from './db/client.js';
import type { Item } from './db/repo.js';
import { env } from './env.js';
import { dollars } from './policy/pricing.js';
import { formatSlotLong } from './policy/windows.js';

/** Derived from the API token, so the token itself never appears in a link. */
export const listingsKey = () => createHash('sha256').update(`listings:${env.API_TOKEN}`).digest('hex').slice(0, 20);
export const listingsUrl = () => (env.PUBLIC_BASE_URL && env.API_TOKEN ? `${env.PUBLIC_BASE_URL}/l/${listingsKey()}` : undefined);

const h = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

type Row = Item & { buyers: number; blocked: number; lowballs: number; best_cents: number | null; pickup_at: Date | null; pickup_name: string | null; pickup_cents: number | null };

export async function listingsHtml(): Promise<string> {
  const rows = await q<Row>(
    `select i.*,
       (select count(*)::int from buyers b where b.item_id = i.id) as buyers,
       (select count(*)::int from buyers b where b.item_id = i.id and b.status = 'blocked') as blocked,
       (select count(*)::int from messages m join buyers b on b.id = m.buyer_id where b.item_id = i.id and m.direction = 'out' and m.intent in ('counter','counter_final','injection')) as lowballs,
       (select max(coalesce(b.agreed_cents, b.last_offer_cents)) from buyers b where b.item_id = i.id and b.status <> 'blocked') as best_cents,
       s.starts_at as pickup_at, split_part(coalesce(sb.display_name, sb.email), ' ', 1) as pickup_name, sb.agreed_cents as pickup_cents
     from items i
     left join lateral (select * from slots s where s.item_id = i.id and s.status in ('confirmed','address_sent','reminded') order by s.starts_at limit 1) s on true
     left join buyers sb on sb.id = s.buyer_id
     where i.status <> 'deleted'
     order by coalesce(i.sold_at, i.listed_at, i.created_at) desc limit 100`,
  );
  const live = rows.filter((r) => ['listed', 'pending', 'paused', 'draft'].includes(r.status));
  const sold = rows.filter((r) => r.status === 'sold');
  const total = sold.reduce((sum, r) => sum + (r.sold_cents ?? 0), 0);
  const key = listingsKey();
  const date = (d: Date | null) => (d ? formatSlotLong(d).split(',')[0] : '');
  const card = (r: Row) => `
    <article>
      ${r.photos?.[0]?.telegram_file_id ? `<img src="/l/${key}/photo/${r.id}" alt="">` : '<div class="ph"></div>'}
      <div class="body">
        <div class="top"><h2>${h(r.title ?? 'Item')}</h2><span class="chip ${h(r.status)}">${h(r.status === 'pending' ? 'pickup booked' : r.status)}</span></div>
        ${
          r.status === 'sold'
            ? `<p class="price">Sold <b>${dollars(r.sold_cents)}</b> <span>${h(date(r.sold_at))}</span></p>`
            : `<p class="price"><b>${dollars(r.ask_cents)}</b> <span>floor ${dollars(r.floor_cents)}</span></p>`
        }
        ${r.pickup_at ? `<p class="pickup">Pickup ${h(formatSlotLong(r.pickup_at))} with ${h(r.pickup_name)} at ${dollars(r.pickup_cents)}</p>` : ''}
        <p class="meta">${r.buyers} buyer${r.buyers === 1 ? '' : 's'} · ${r.lowballs} lowball${r.lowballs === 1 ? '' : 's'} countered · ${r.blocked} scam${r.blocked === 1 ? '' : 's'} blocked${r.best_cents != null && r.status !== 'sold' ? ` · best offer ${dollars(r.best_cents)}` : ''}</p>
        ${r.status !== 'sold' && r.inbox_address ? `<p class="meta">Buyers write to ${h(r.inbox_address)}${r.listed_at ? ` · listed ${h(date(r.listed_at))}` : ''}</p>` : ''}
      </div>
    </article>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="15">
<title>Lowball listings</title><style>
:root{--bg:#0d0f12;--card:#161a20;--line:#252b34;--text:#e9edf2;--muted:#8b95a3;--accent:#ffb224}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:28px 16px 64px}h1{font-size:28px;margin:0 0 4px}header p{color:var(--muted);margin:0 0 28px}
h3{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:32px 0 12px}
article{display:flex;gap:16px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:12px}
img,.ph{width:96px;height:96px;border-radius:10px;object-fit:cover;background:var(--line);flex:none}.body{min-width:0;flex:1}
.top{display:flex;gap:10px;align-items:flex-start;justify-content:space-between}h2{font-size:18px;margin:0;overflow-wrap:anywhere}
.chip{font-size:12px;padding:2px 10px;border-radius:999px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}.chip.pending,.chip.sold{color:var(--accent);border-color:var(--accent)}
.price{margin:6px 0 2px;font-size:20px}.price span{font-size:14px;color:var(--muted);margin-left:8px}.price b{color:var(--accent)}
.pickup{margin:2px 0;color:var(--text)}.meta{margin:2px 0;color:var(--muted);font-size:14px;overflow-wrap:anywhere}.empty{color:var(--muted)}
</style></head><body><main>
<header><h1>Lowball</h1><p>${live.length} for sale · ${sold.length} sold${sold.length > 0 ? ` · ${dollars(total)} total` : ''}</p></header>
<h3>For sale</h3>${live.length > 0 ? live.map(card).join('') : '<p class="empty">Nothing listed. Send a photo to the Telegram bot.</p>'}
<h3>Sales history</h3>${sold.length > 0 ? sold.map(card).join('') : '<p class="empty">No sales yet.</p>'}
</main></body></html>`;
}
