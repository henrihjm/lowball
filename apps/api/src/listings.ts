// The owner's web app: every listing as a photo card, and one page per item with the
// ad details Lowball uses everywhere. Server-rendered, behind an unguessable key in the URL.
import { createHash } from 'node:crypto';
import { q, q1 } from './db/client.js';
import type { Item } from './db/repo.js';
import { env } from './env.js';
import { dollars } from './policy/pricing.js';
import { formatSlotLong } from './policy/windows.js';

/** Derived from the API token, so the token itself never appears in a link. */
export const listingsKey = () => createHash('sha256').update(`listings:${env.API_TOKEN}`).digest('hex').slice(0, 20);
export const listingsUrl = () => (env.PUBLIC_BASE_URL && env.API_TOKEN ? `${env.PUBLIC_BASE_URL}/l/${listingsKey()}` : undefined);

const h = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

type Row = Item & { buyers: number; blocked: number; lowballs: number; best_cents: number | null; pickup_at: Date | null; pickup_name: string | null; pickup_cents: number | null };

const ROW_SQL = `select i.*,
   (select count(*)::int from buyers b where b.item_id = i.id) as buyers,
   (select count(*)::int from buyers b where b.item_id = i.id and b.status = 'blocked') as blocked,
   (select count(*)::int from messages m join buyers b on b.id = m.buyer_id where b.item_id = i.id and m.direction = 'out' and m.intent in ('counter','counter_final','injection')) as lowballs,
   (select max(coalesce(b.agreed_cents, b.last_offer_cents)) from buyers b where b.item_id = i.id and b.status <> 'blocked') as best_cents,
   s.starts_at as pickup_at, split_part(coalesce(sb.display_name, sb.email), ' ', 1) as pickup_name, sb.agreed_cents as pickup_cents
 from items i
 left join lateral (select * from slots s where s.item_id = i.id and s.status in ('confirmed','address_sent','reminded') order by s.starts_at limit 1) s on true
 left join buyers sb on sb.id = s.buyer_id`;

const CSS = `
:root{--bg:#fff;--soft:#f5f5f7;--line:#e8e8ed;--text:#1d1d1f;--muted:#86868b;--accent:#0071e3;--ok:#1d9a54;--r:20px}
*{box-sizing:border-box}html{-webkit-font-smoothing:antialiased}
body{margin:0;background:var(--bg);color:var(--text);font:17px/1.47 -apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display","Helvetica Neue",Helvetica,Arial,sans-serif;letter-spacing:-.01em}
a{color:inherit;text-decoration:none}
nav{max-width:1080px;margin:0 auto;padding:22px 24px;display:flex;align-items:center;justify-content:space-between}
.brand{font-weight:600;font-size:26px;letter-spacing:-.03em;display:inline-flex;align-items:baseline;padding-top:10px}
.wb{flex:none;display:inline-block;position:relative;width:.64em;height:.72em;margin:0 .03em 0 .05em;transform-origin:.06em -.5em;animation:swing 2.6s cubic-bezier(.37,0,.22,1) .15s both}
.wb:before{content:"";position:absolute;left:0;top:-.5em;width:.115em;height:1.2em;border-radius:.03em;background:currentColor}
.wb:after{content:"";position:absolute;left:.02em;bottom:-.015em;width:.6em;height:.6em;border-radius:50%;background:currentColor}
@keyframes swing{0%{transform:rotate(42deg)}22%{transform:rotate(-27deg)}42%{transform:rotate(16deg)}60%{transform:rotate(-9deg)}76%{transform:rotate(5deg)}89%{transform:rotate(-2deg)}100%{transform:rotate(0)}}
@media (prefers-reduced-motion:reduce){.wb{animation:none}}.back{color:var(--muted);font-size:15px}
main{max-width:1080px;margin:0 auto;padding:8px 24px 96px}
.hero{padding:36px 0 40px}.hero h1{font-size:56px;line-height:1.05;font-weight:600;letter-spacing:-.035em;margin:0}.hero p{margin:10px 0 0;color:var(--muted);font-size:21px}
.label{font-size:13px;font-weight:600;color:var(--muted);margin:40px 0 16px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:24px}
.card{display:block;border-radius:var(--r);background:var(--bg);transition:transform .2s ease}.card:hover{transform:translateY(-3px)}
.photo{aspect-ratio:4/3;border-radius:var(--r);background:var(--soft) center/cover no-repeat;display:flex;align-items:center;justify-content:center;color:#c7c7cc;font-size:64px;font-weight:600;position:relative;overflow:hidden}
.pill{position:absolute;top:14px;left:14px;background:rgba(255,255,255,.92);backdrop-filter:blur(12px);color:var(--text);font-size:13px;font-weight:600;padding:5px 12px;border-radius:999px}
.pill.go{color:var(--ok)}.pill.sold{color:var(--muted)}
.card h2{font-size:17px;font-weight:600;margin:14px 2px 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card .sub{margin:0 2px;color:var(--muted);font-size:15px;display:flex;justify-content:space-between;gap:12px}.card .sub b{color:var(--text);font-weight:600}
.drop{display:block}.drop .photo{cursor:pointer;margin:0}.add{position:absolute;bottom:14px;right:14px;background:rgba(255,255,255,.92);backdrop-filter:blur(12px);color:var(--text);font-size:13px;font-weight:600;padding:6px 14px;border-radius:999px}
.empty{background:var(--soft);border-radius:var(--r);padding:56px 24px;text-align:center;color:var(--muted)}
.detail{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);gap:56px;align-items:start;padding-top:12px}
.detail .photo{aspect-ratio:1/1;font-size:120px}
.now{font-size:15px;font-weight:600;color:var(--ok);margin:0 0 6px}.now.muted{color:var(--muted)}
.detail h1{font-size:34px;line-height:1.12;font-weight:600;letter-spacing:-.025em;margin:0 0 6px}
.big{font-size:44px;font-weight:600;letter-spacing:-.03em;margin:0}.big span{font-size:17px;font-weight:400;color:var(--muted);letter-spacing:0;margin-left:10px}
.facts{display:flex;gap:28px;margin:22px 0 30px;padding:18px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.facts div{font-size:13px;color:var(--muted)}.facts b{display:block;font-size:21px;font-weight:600;color:var(--text);letter-spacing:-.02em}
form{display:grid;gap:16px}.row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
label{display:block;font-size:13px;font-weight:600;color:var(--muted);margin:0 0 6px 2px}
input,textarea{width:100%;font:inherit;color:var(--text);background:var(--soft);border:1px solid transparent;border-radius:14px;padding:13px 15px;outline:none;transition:border-color .15s,background .15s}
textarea{min-height:128px;resize:vertical;line-height:1.45}input:focus,textarea:focus{background:#fff;border-color:var(--accent);box-shadow:0 0 0 4px rgba(0,113,227,.12)}
.money{position:relative}.money input{padding-left:28px}.money:before{content:"$";position:absolute;left:15px;top:13px;color:var(--muted)}
.actions{display:flex;align-items:center;gap:16px;margin-top:6px}
button{font:inherit;font-weight:600;color:#fff;background:var(--accent);border:0;border-radius:999px;padding:13px 30px;cursor:pointer;transition:opacity .15s}button:hover{opacity:.88}
.hint{color:var(--muted);font-size:14px;margin:0}.saved{color:var(--ok);font-weight:600;font-size:15px}.err{color:#d70015;font-weight:600;font-size:15px}
.where{margin-top:30px;background:var(--soft);border-radius:var(--r);padding:18px 20px;font-size:15px;color:var(--muted)}.where b{color:var(--text);font-weight:600}
@media (max-width:820px){.detail{grid-template-columns:1fr;gap:28px}.hero h1{font-size:40px}.row{grid-template-columns:1fr}}
`;

/** The wordmark. The b is a wrecking ball: it swings in on load and settles into the letter. */
const BRAND = (key: string) => `<a class="brand" href="/l/${key}" aria-label="Lowball"><span aria-hidden="true">Low</span><span class="wb" aria-hidden="true"></span><span aria-hidden="true">all</span></a>`;

const page = (title: string, nav: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${h(title)}</title><style>${CSS}</style></head><body><nav>${nav}</nav><main>${body}</main></body></html>`;

const hasPhoto = (r: Item) => Boolean(r.photos?.[0]?.telegram_file_id || r.photos?.[0]?.data);
const photoStyle = (key: string, r: Item) => (hasPhoto(r) ? ` style="background-image:url('/l/${key}/photo/${r.id}?v=${(r.photos?.[0]?.data ?? '').length}')"` : '');
const initial = (r: Item) => (hasPhoto(r) ? '' : h((r.title ?? '?').trim()[0]?.toUpperCase() ?? '?'));

function status(r: Row): { text: string; cls: string } {
  if (r.status === 'sold') return { text: `Sold ${dollars(r.sold_cents)}`, cls: 'sold' };
  if (r.pickup_at) return { text: `Pickup ${formatSlotLong(r.pickup_at).split(',')[0]}`, cls: 'go' };
  if (r.status === 'paused') return { text: 'Paused', cls: 'sold' };
  if (r.best_cents != null) return { text: `Best offer ${dollars(r.best_cents)}`, cls: 'go' };
  return { text: r.buyers > 0 ? `${r.buyers} interested` : 'Listed', cls: '' };
}

export async function listingsHtml(): Promise<string> {
  const key = listingsKey();
  const rows = await q<Row>(`${ROW_SQL} where i.status <> 'deleted' and i.status <> 'draft' order by coalesce(i.sold_at, i.listed_at, i.created_at) desc limit 100`);
  const live = rows.filter((r) => r.status !== 'sold');
  const sold = rows.filter((r) => r.status === 'sold');
  const earned = sold.reduce((sum, r) => sum + (r.sold_cents ?? 0), 0);
  const card = (r: Row) => {
    const s = status(r);
    return `<a class="card" href="/l/${key}/item/${r.id}"><div class="photo"${photoStyle(key, r)}>${initial(r)}<span class="pill ${s.cls}">${h(s.text)}</span></div><h2>${h(r.title ?? 'Item')}</h2><p class="sub"><b>${dollars(r.status === 'sold' ? r.sold_cents : r.ask_cents)}</b><span>${r.buyers} buyer${r.buyers === 1 ? '' : 's'}</span></p></a>`;
  };
  const headline = sold.length > 0 ? `${dollars(earned)} earned.` : live.length > 0 ? `${live.length} thing${live.length === 1 ? '' : 's'} selling.` : 'Nothing listed yet.';
  const sub = live.length > 0 ? 'Lowball is handling every buyer. You get a calendar invite when a pickup is booked.' : 'Send a photo to the Telegram bot. That is all it takes.';
  return page(
    'Lowball',
    `${BRAND(key)}<span class="back">${live.length} selling · ${sold.length} sold</span>`,
    `<section class="hero"><h1>${h(headline)}</h1><p>${h(sub)}</p></section>
     ${live.length > 0 ? `<div class="grid">${live.map(card).join('')}</div>` : '<div class="empty">Your listings appear here.</div>'}
     ${sold.length > 0 ? `<p class="label">Sold</p><div class="grid">${sold.map(card).join('')}</div>` : ''}`,
  ).replace('</head>', '<meta http-equiv="refresh" content="20"></head>');
}

export async function itemHtml(id: string, flash?: { ok?: string; err?: string }): Promise<string | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  const key = listingsKey();
  const r = await q1<Row>(`${ROW_SQL} where i.id = $1 and i.status <> 'deleted'`, [id]);
  if (!r) return undefined;
  const s = status(r);
  const sold = r.status === 'sold';
  const now = sold ? `Sold for ${dollars(r.sold_cents)}` : r.pickup_at ? `Pickup booked: ${formatSlotLong(r.pickup_at)} with ${r.pickup_name} at ${dollars(r.pickup_cents)}` : r.best_cents != null ? `Best offer so far ${dollars(r.best_cents)}` : 'Listed. Waiting for buyers.';
  return page(
    r.title ?? 'Item',
    `${BRAND(key)}<a class="back" href="/l/${key}">All listings</a>`,
    `<section class="detail">
      <form class="drop" method="post" action="/l/${key}/item/${r.id}/photo" enctype="multipart/form-data">
        <label class="photo" for="file"${photoStyle(key, r)}>${initial(r)}<span class="pill ${s.cls}">${h(s.text)}</span><span class="add">${hasPhoto(r) ? 'Change photo' : 'Add photo'}</span></label>
        <input id="file" type="file" name="photo" accept="image/jpeg,image/png,image/webp" onchange="this.form.submit()" hidden>
      </form>
      <div>
        <p class="now${sold ? ' muted' : ''}">${h(now)}</p>
        <h1>${h(r.title ?? 'Item')}</h1>
        <p class="big">${dollars(sold ? r.sold_cents : r.ask_cents)}${sold ? '' : `<span>lowest ${dollars(r.floor_cents)}</span>`}</p>
        <div class="facts"><div><b>${r.buyers}</b>buyers</div><div><b>${r.lowballs}</b>lowballs countered</div><div><b>${r.blocked}</b>scams blocked</div></div>
        <form method="post" action="/l/${key}/item/${r.id}">
          <div><label for="title">Title</label><input id="title" name="title" value="${h(r.title)}" maxlength="120" required></div>
          <div class="row">
            <div><label for="ask">Price</label><div class="money"><input id="ask" name="ask" inputmode="numeric" value="${r.ask_cents != null ? r.ask_cents / 100 : ''}" required></div></div>
            <div><label for="floor">Lowest you'd take</label><div class="money"><input id="floor" name="floor" inputmode="numeric" value="${r.floor_cents != null ? r.floor_cents / 100 : ''}" required></div></div>
          </div>
          <div><label for="condition">Condition</label><input id="condition" name="condition" value="${h(r.condition_notes)}" maxlength="200"></div>
          <div><label for="description">Description</label><textarea id="description" name="description" maxlength="2000">${h(r.description)}</textarea></div>
          <div class="actions"><button type="submit">Save</button>${flash?.ok ? `<span class="saved">${h(flash.ok)}</span>` : flash?.err ? `<span class="err">${h(flash.err)}</span>` : '<p class="hint">One ad. Lowball uses it everywhere.</p>'}</div>
        </form>
        <div class="where">Buyers reach this ad at <b>${h(r.inbox_address ?? 'its Lowball inbox')}</b>${r.craigslist_url ? ` and on <a href="${h(r.craigslist_url)}"><b>Craigslist</b></a>` : ''}. Lowball answers every one of them.</div>
      </div>
    </section>`,
  );
}

/** Saves the ad fields. The negotiator reads these on every reply, so a change applies at once. */
export async function saveItem(id: string, form: Record<string, unknown>): Promise<{ ok?: string; err?: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { err: 'Unknown item.' };
  const text = (k: string, max: number) => String(form[k] ?? '').trim().slice(0, max);
  const money = (k: string) => Math.round(parseFloat(String(form[k] ?? '').replace(/[$,\s]/g, '')) * 100);
  const title = text('title', 120);
  const ask = money('ask');
  const floor = money('floor');
  if (!title) return { err: 'Give it a title.' };
  if (!Number.isFinite(ask) || ask <= 0 || !Number.isFinite(floor) || floor <= 0) return { err: 'Price and lowest price need to be numbers.' };
  if (floor > ask) return { err: 'The lowest price cannot be above the price.' };
  const clean = (s: string) => s.replace(/[—–]/g, ',');
  await q("update items set title = $2, ask_cents = $3, floor_cents = $4, condition_notes = nullif($5, ''), description = nullif($6, '') where id = $1 and status <> 'deleted'", [
    id,
    clean(title),
    ask,
    floor,
    clean(text('condition', 200)),
    clean(text('description', 2000)),
  ]);
  return { ok: 'Saved. Live now.' };
}

/** A photo added from the web app. Stored with the item, at most 3 MB. */
export async function savePhoto(id: string, file: unknown): Promise<{ ok?: string; err?: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { err: 'Unknown item.' };
  if (!(file instanceof File) || file.size === 0) return { err: 'Choose a photo.' };
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return { err: 'Use a JPEG, PNG or WebP photo.' };
  if (file.size > 3_000_000) return { err: 'That photo is over 3 MB. Use a smaller one.' };
  const data = Buffer.from(await file.arrayBuffer()).toString('base64');
  await q("update items set photos = $2::jsonb where id = $1 and status <> 'deleted'", [id, JSON.stringify([{ data, mime: file.type }])]);
  return { ok: 'Photo saved.' };
}
