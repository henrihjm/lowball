// Telegram: Henri's front door. Photo in, proposal card out, decisions by button, digest out.
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@mastra/core/agent';
import { Bot, InlineKeyboard, type Context } from 'grammy';
import { z } from 'zod';
import { q } from '../db/client.js';
import { getItem, getUser } from '../db/repo.js';
import { env } from '../env.js';
import { gatewayModel, generateJson } from '../mastra/model.js';
import type { Photo } from '../mastra/agents/identifier.js';
import { postItem } from '../mastra/workflows/lifecycle.js';
import { cardFor, listItem, setListingText, setPrice } from '../mastra/workflows/listItem.js';
import { runOperator } from '../mastra/workflows/operator.js';
import { markSold } from '../mastra/workflows/lifecycle.js';
import { resolveDecision } from '../mastra/workflows/resolve.js';
import { listingsUrl } from '../listings.js';
import { dollars } from '../policy/pricing.js';
import { parseWindows } from '../policy/windows.js';
import { setNotifier, type Button } from './notify.js';
import * as tpl from './templates.js';

let bot: Bot | undefined;
let ownerChatId: number | undefined;
let state = 'not configured';

type Awaiting = { kind: 'onboarding' } | { kind: 'price'; itemId: string } | { kind: 'text'; itemId: string } | { kind: 'amount'; itemId: string };
let awaiting: Awaiting | undefined;

export const telegramStatus = () => state;

const keyboard = (buttons?: Button[]) => {
  if (!buttons || buttons.length === 0) return undefined;
  const kb = new InlineKeyboard();
  for (const b of buttons) kb.text(b.text, b.data);
  return kb;
};

// ---------- photos ----------

const photoCache = new Map<string, { bytes: Buffer; mime: string }>();

async function download(fileId: string): Promise<{ bytes: Buffer; mime: string }> {
  const cached = photoCache.get(fileId);
  if (cached) return cached;
  const file = await bot!.api.getFile(fileId);
  const res = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
  if (!res.ok) throw new Error(`telegram file download failed: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const mime = file.file_path?.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const out = { bytes, mime };
  photoCache.set(fileId, out);
  if (photoCache.size > 40) photoCache.delete(photoCache.keys().next().value!);
  // Kept on disk too, so the Craigslist posting step can upload them.
  const dir = join(tmpdir(), 'lowball-photos');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${fileId.replace(/[^\w-]/g, '_')}.${mime === 'image/png' ? 'png' : 'jpg'}`), bytes).catch(() => undefined);
  return out;
}

/** First photo of an item, for the board. The bot token never leaves this process. */
export async function itemPhoto(itemId: string): Promise<{ bytes: Buffer; mime: string } | undefined> {
  const item = await getItem(itemId);
  const fileId = item?.photos?.[0]?.telegram_file_id;
  if (!fileId || !bot) return undefined;
  return download(fileId).catch(() => undefined);
}

const groups = new Map<string, { fileIds: string[]; caption?: string; timer?: NodeJS.Timeout; ctx: Context }>();

/** Posts the item and tells Henri: what it is listed at, and where all his listings live. */
async function postAndAnnounce(ctx: Context, itemId: string): Promise<void> {
  const address = await postItem(itemId);
  const item = (await getItem(itemId))!;
  await ctx.reply(
    `Posted for sale: ${item.title}. Ask ${dollars(item.ask_cents)}, floor ${dollars(item.floor_cents)}, drops ${Number(item.decay_pct)}% every ${item.decay_every_days} days to the floor.\n"${item.description ?? ''}"\nBuyers write to ${address}. I handle them from here. The next thing you get is a calendar invite for the pickup.`,
    { reply_markup: keyboard([{ text: 'Change price', data: `i:${itemId}:price` }, { text: 'Edit text', data: `i:${itemId}:text` }]) },
  );
  const url = listingsUrl();
  if (url) await ctx.reply(`All your listings and sales history: ${url}`, { link_preview_options: { is_disabled: true } });
  if (env.KERNEL_POSTING && env.KERNEL_API_KEY) {
    const { kernelPostCore } = await import('../mastra/tools/kernelPost.js');
    const posted = await kernelPostCore(itemId).catch(() => undefined);
    if (posted?.ok) await ctx.reply(`The Craigslist form is filled in. Add the ZIP code and photos and submit: ${posted.liveViewUrl}`, { link_preview_options: { is_disabled: true } });
  }
}

async function processPhotos(ctx: Context, fileIds: string[], caption?: string): Promise<void> {
  await ctx.reply(`Got the photo${fileIds.length > 1 ? 's' : ''}. Looking at ${fileIds.length > 1 ? 'them' : 'it'}.`);
  try {
    const photos: Photo[] = [];
    for (const id of fileIds.slice(0, 3)) {
      const f = await download(id);
      photos.push({ base64: f.bytes.toString('base64'), mime: f.mime });
    }
    const card = await listItem({ photos, telegramFileIds: fileIds, caption });
    if ('error' in card) {
      await ctx.reply(card.error);
      return;
    }
    const item = (await getItem(card.itemId))!;
    if (card.needsPrice) {
      // Too few comparable sales to price it honestly: the one question Henri is asked.
      await ctx.reply(card.text);
      awaiting = { kind: 'price', itemId: card.itemId };
      return;
    }
    const prices = (item.comps ?? []).map((c) => c.price_cents);
    await ctx.reply(
      `${item.title}. ${item.condition_notes ? item.condition_notes[0]!.toUpperCase() + item.condition_notes.slice(1) : 'Condition as pictured'}. Similar ones go for ${dollars(Math.min(...prices))} to ${dollars(Math.max(...prices))} (${prices.length} comparable listings).`,
    );
    await postAndAnnounce(ctx, card.itemId);
  } catch (err) {
    console.error('[telegram] photo failed:', err);
    await ctx.reply('That did not work. Send the photo again, with a caption saying what it is.');
  }
}

// ---------- onboarding ----------

const profiler = new Agent({
  id: 'profiler',
  name: 'Profile reader',
  instructions: `You read one message in which a seller states: their pickup neighborhood, their usual pickup windows, and how they take money.
Reply with only JSON: {"neighborhood": string, "pickup_windows": string, "payment_methods": string}
pickup_windows must use this exact format: day names separated by "/", then a 24h range, groups separated by ", ". Example: "Mon/Tue/Wed/Thu/Fri 18:00-20:00, Sat 10:00-12:00".
payment_methods is short, e.g. "cash or Venmo @henri".`,
  model: () => gatewayModel('text'),
});
const profileSchema = z.object({ neighborhood: z.string(), pickup_windows: z.string(), payment_methods: z.string() });

async function saveProfile(text: string): Promise<string> {
  let p = await generateJson(profiler, text.slice(0, 600), profileSchema, 'profile', 15_000);
  if (!p || parseWindows(p.pickup_windows).length === 0) {
    // No model, or it did not produce parseable windows: split the message by its own structure.
    const parts = text.split(/\s*(?:\d\s*[).:]|\n|;)\s*/).map((s) => s.trim()).filter(Boolean);
    const [a, b, c] = parts.length >= 3 ? parts : text.split(/\s*,\s*/);
    p = { neighborhood: a ?? text, pickup_windows: p?.pickup_windows ?? b ?? '', payment_methods: c ?? 'cash' };
  }
  await q("update users set neighborhood = $1, pickup_windows = $2, payment_methods = $3 where id = 'henri'", [p.neighborhood, p.pickup_windows, p.payment_methods]);
  const note = parseWindows(p.pickup_windows).length === 0 ? ' I could not read the pickup times. Send them like "windows Tue/Thu 18:00-20:00, Sat 10:00-12:00".' : '';
  return `${tpl.onboardingSaved(p.neighborhood, p.pickup_windows || 'pickup times to be agreed', p.payment_methods)}${note}\nOne more: send "spot" and where buyers meet you (e.g. "spot building lobby, 1234 X St"). I only share it two hours before a confirmed pickup.`;
}

// ---------- bot ----------

export async function startTelegram(): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  const user = await getUser();
  ownerChatId = env.TELEGRAM_OWNER_CHAT_ID ? Number(env.TELEGRAM_OWNER_CHAT_ID) : user.telegram_chat_id ?? undefined;

  // Single user. The first chat to write claims the bot unless TELEGRAM_OWNER_CHAT_ID pins it.
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    if (ownerChatId == null) {
      ownerChatId = chatId;
      await q("update users set telegram_chat_id = $1 where id = 'henri'", [chatId]);
      console.log(`[telegram] owner chat id is ${chatId}. Put TELEGRAM_OWNER_CHAT_ID=${chatId} in .env to pin it.`);
    }
    if (chatId !== ownerChatId) {
      if (ctx.message) await ctx.reply('This bot is private.');
      return;
    }
    await next();
  });

  setNotifier(async (msg) => {
    if (ownerChatId == null) throw new Error('owner chat id unknown: send the bot a message first');
    await bot!.api.sendMessage(ownerChatId, msg.text, { reply_markup: keyboard(msg.buttons), link_preview_options: { is_disabled: true } });
  });

  bot.command('start', async (ctx) => {
    const u = await getUser();
    if (!u.pickup_windows) {
      awaiting = { kind: 'onboarding' };
      await ctx.reply(tpl.onboarding);
    } else {
      await ctx.reply('Send me a photo of anything you want gone.');
    }
  });

  bot.on('message:photo', async (ctx) => {
    const fileId = ctx.message.photo.at(-1)!.file_id; // largest size
    const groupId = ctx.message.media_group_id;
    if (!groupId) return processPhotos(ctx, [fileId], ctx.message.caption);
    // An album arrives as separate messages: buffer 2 seconds and treat it as one item.
    const g = groups.get(groupId) ?? { fileIds: [], ctx };
    g.fileIds.push(fileId);
    g.caption ??= ctx.message.caption;
    if (g.timer) clearTimeout(g.timer);
    g.timer = setTimeout(() => {
      groups.delete(groupId);
      void processPhotos(g.ctx, g.fileIds, g.caption);
    }, 2000);
    groups.set(groupId, g);
  });

  bot.on('callback_query:data', async (ctx) => {
    const [scope, id, key] = ctx.callbackQuery.data.split(':');
    await ctx.answerCallbackQuery().catch(() => undefined);
    const original = ctx.callbackQuery.message?.text ?? '';
    const choice = ctx.callbackQuery.message?.reply_markup?.inline_keyboard.flat().find((b) => 'callback_data' in b && b.callback_data === ctx.callbackQuery.data)?.text;
    const stamp = () => ctx.editMessageText(`${original}\n\n> ${choice ?? key}`).catch(() => undefined);
    try {
      if (scope === 'd' && id && key) {
        const res = await resolveDecision(id, key);
        await stamp();
        if (res.awaitAmountForItem) awaiting = { kind: 'amount', itemId: res.awaitAmountForItem };
        await ctx.reply(res.text, { link_preview_options: { is_disabled: true } });
      } else if (scope === 'i' && id && key === 'post') {
        const item = await getItem(id);
        if (!item || item.status !== 'draft') {
          await ctx.reply('Already posted.');
          return;
        }
        await stamp();
        const address = await postItem(id);
        if (env.KERNEL_POSTING && env.KERNEL_API_KEY) {
          await ctx.reply('Posting it on Craigslist now.');
          const { kernelPostCore } = await import('../mastra/tools/kernelPost.js');
          const posted = await kernelPostCore(id).catch((err) => ({ ok: false as const, reason: (err as Error).message, liveViewUrl: undefined }));
          if (posted.ok) {
            // The form is filled in a Kernel browser. Photos and the final submit are one look away.
            await ctx.reply(`The Craigslist form is filled in. Add the photos and submit here: ${posted.liveViewUrl}\nBuyers write to ${address}. I'll handle them and only message you for a decision.`, { link_preview_options: { is_disabled: true } });
            return;
          }
          await ctx.reply(`Craigslist posting did not go through (${posted.reason}).`);
        }
        await ctx.reply(tpl.afterPostManual(address));
        await ctx.reply((await getItem(id))?.description ?? '');
      } else if (scope === 'i' && id && key === 'price') {
        awaiting = { kind: 'price', itemId: id };
        await ctx.reply('Send the new price, e.g. "220 floor 160".');
      } else if (scope === 'i' && id && key === 'text') {
        awaiting = { kind: 'text', itemId: id };
        await ctx.reply('Send the listing text you want.');
      }
    } catch (err) {
      console.error('[telegram] button failed:', err);
      await ctx.reply('That did not work. Try again.');
    }
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    const pending = awaiting;
    try {
      if (pending?.kind === 'onboarding' || (!pending && !(await getUser()).pickup_windows && !text.startsWith('/'))) {
        awaiting = undefined;
        await ctx.reply(await saveProfile(text));
        return;
      }
      if (pending?.kind === 'price') {
        const problem = await setPrice(pending.itemId, text);
        if (problem) {
          await ctx.reply(problem);
          return;
        }
        awaiting = undefined;
        const priced = (await getItem(pending.itemId))!;
        if (priced.status === 'draft') await postAndAnnounce(ctx, pending.itemId);
        else await ctx.reply(`Price updated: ask ${dollars(priced.ask_cents)}, floor ${dollars(priced.floor_cents)}.`);
        return;
      }
      if (pending?.kind === 'text') {
        awaiting = undefined;
        await setListingText(pending.itemId, text);
        await ctx.reply('Listing text updated.');
        return;
      }
      if (pending?.kind === 'amount') {
        const m = text.match(/\$?\s*(\d[\d,]*(?:\.\d{1,2})?)/);
        if (!m) {
          await ctx.reply('Send just the amount, e.g. 170.');
          return;
        }
        awaiting = undefined;
        await ctx.reply(await markSold(pending.itemId, Math.round(parseFloat(m[1]!.replace(/,/g, '')) * 100)));
        return;
      }
      await ctx.reply(await runOperator(text), { link_preview_options: { is_disabled: true } });
    } catch (err) {
      console.error('[telegram] text failed:', err);
      await ctx.reply('That did not work. Try again.');
    }
  });

  bot.catch((err) => console.error('[telegram] error:', err.message));

  const me = await bot.api.getMe();
  state = `@${me.username}${ownerChatId == null ? ' (waiting for the first message to learn the owner chat id)' : ''}`;
  // Long polling works everywhere, including on Fly, and needs no public URL.
  void bot.start({ drop_pending_updates: false, onStart: () => console.log(`[telegram] @${me.username} is polling`) }).catch((err) => {
    state = `error: ${(err as Error).message}`;
    console.error('[telegram] polling stopped:', (err as Error).message);
  });
}
