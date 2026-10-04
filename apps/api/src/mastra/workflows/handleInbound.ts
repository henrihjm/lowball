// handleInbound: classify -> negotiate -> validate -> send -> log.
// One inbound buyer email in, at most one reply out, in the same thread.
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { q, q1 } from '../../db/client.js';
import {
  activeSlot,
  addClock,
  firstName,
  getBuyer,
  getItem,
  getUser,
  itemForInbox,
  logNote,
  logOutbound,
  type Buyer,
  type Item,
  type Message,
} from '../../db/repo.js';
import { DAY_MS, now } from '../../demo/clock.js';
import { replyInThread } from '../../email/agentmail.js';
import { classifyInbound, cleanBody, heuristicClassify, parseAddress, systemMailKind } from '../../email/classify.js';
import { env } from '../../env.js';
import {
  canSendNow,
  decide,
  detectInjection,
  extractOfferCents,
  injectionReply,
  mayMentionOtherInterest,
  MAX_COUNTERS,
  OUTBOUND_COOLDOWN_MS,
  PENDING_REPLY,
  validateReply,
  type Decision,
} from '../../policy/negotiation.js';
import { dollars, roundTo5 } from '../../policy/pricing.js';
import { matchScamRules } from '../../policy/scam.js';
import { buyerScore } from '../../policy/scoring.js';
import { formatSlot, formatSlotLong, isInsideWindows, parseBuyerTime, parseWindows, upcomingSlots, type BuyerTime } from '../../policy/windows.js';
import { notifyOwner } from '../../telegram/notify.js';
import * as tpl from '../../telegram/templates.js';
import { acceptOfferCore, approvedCents } from '../tools/acceptOffer.js';
import { blockBuyerCore } from '../tools/blockBuyer.js';
import { scheduleSlotCore } from '../tools/scheduleSlot.js';
import { createDecision } from './decisions.js';
import { writeReply, type Brief, type ReplyKind } from './writeReply.js';

export interface InboundEmail {
  inboxId: string;
  threadId?: string | null;
  messageId: string;
  from: string;
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  extractedText?: string | null;
}

export type InboundResult =
  | { status: 'replied'; buyerId: string; kind: string; text: string }
  | { status: 'silent'; buyerId?: string; reason: string };

const MAX_REPLIES_PER_BUYER = 15;

// ---------- queue: concurrency 5, one message at a time per buyer ----------

const CONCURRENCY = 5;
let running = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= CONCURRENCY) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

const buyerChains = new Map<string, Promise<unknown>>();

function withBuyerLock<T>(buyerId: string, fn: () => Promise<T>): Promise<T> {
  const prev = buyerChains.get(buyerId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  buyerChains.set(buyerId, next);
  void next.catch(() => undefined).finally(() => {
    if (buyerChains.get(buyerId) === next) buyerChains.delete(buyerId);
  });
  return next;
}

export const queueDepth = () => ({ running, waiting: waiting.length });

/** Webhook entry point. Returns immediately; the work runs through the queue. */
export function enqueueInbound(ev: InboundEmail): void {
  void withSlot(() => handleInbound(ev)).catch((err) => console.error('[inbound] failed:', err));
}

// ---------- pipeline ----------

type Intake = { proceed: true; buyerId: string; inboundId: string } | { proceed: false; result: InboundResult };

/** Who wrote, about which item, and have we seen this message before. */
async function intake(ev: InboundEmail): Promise<Intake> {
  const { name, email } = parseAddress(ev.from);
  const item = await itemForInbox(ev.inboxId);
  if (!item) {
    console.warn(`[inbound] no live item for inbox ${ev.inboxId}; ignoring mail from ${email}`);
    return { proceed: false, result: { status: 'silent', reason: 'no_item' } };
  }

  const system = systemMailKind(email, ev.subject, item.inbox_address);
  if (system === 'craigslist') return { proceed: false, result: await handleCraigslistMail(item, ev) };
  if (system) return { proceed: false, result: { status: 'silent', reason: system } };

  const body = cleanBody(ev.extractedText ?? ev.text, ev.html);
  const at = now();
  const buyer = (await q1<Buyer>(
    `insert into buyers (item_id, email, display_name, thread_id, first_seen, last_inbound)
     values ($1, $2, $3, $4, $5, $5)
     on conflict (item_id, email) do update set
       last_inbound = excluded.last_inbound,
       thread_id = coalesce(excluded.thread_id, buyers.thread_id),
       display_name = coalesce(buyers.display_name, excluded.display_name)
     returning *`,
    [item.id, email, name ?? null, ev.threadId ?? null, at],
  ))!;

  // Idempotency on the AgentMail message id: never reply twice to the same inbound.
  const row = await q1<{ id: string }>(
    `insert into messages (buyer_id, direction, agentmail_message_id, body, created_at)
     values ($1, 'in', $2, $3, $4) on conflict (agentmail_message_id) do nothing returning id`,
    [buyer.id, ev.messageId, body, at],
  );
  if (!row) return { proceed: false, result: { status: 'silent', buyerId: buyer.id, reason: 'duplicate' } };
  return { proceed: true, buyerId: buyer.id, inboundId: row.id };
}

// ---------- the Mastra workflow: intake -> respond ----------

const inboundSchema = z.object({
  inboxId: z.string(),
  threadId: z.string().nullish(),
  messageId: z.string(),
  from: z.string(),
  subject: z.string().nullish(),
  text: z.string().nullish(),
  html: z.string().nullish(),
  extractedText: z.string().nullish(),
});
const resultSchema = z.object({
  status: z.enum(['replied', 'silent']),
  buyerId: z.string().optional(),
  kind: z.string().optional(),
  text: z.string().optional(),
  reason: z.string().optional(),
});
const intakeSchema = z.object({ proceed: z.boolean(), buyerId: z.string().optional(), inboundId: z.string().optional(), result: resultSchema.optional() });

const intakeStep = createStep({
  id: 'intake',
  description: 'Map the sender to a buyer on the item, drop system mail, and dedupe on the AgentMail message id.',
  inputSchema: inboundSchema,
  outputSchema: intakeSchema,
  execute: async ({ inputData }) => intake(inputData),
});

const respondStep = createStep({
  id: 'respond',
  description: 'Scam rules, classification, the numbers (code), the words (negotiator), validation, send in thread, log with reasoning.',
  inputSchema: intakeSchema,
  outputSchema: resultSchema,
  execute: async ({ inputData }) => {
    if (!inputData.proceed || !inputData.buyerId || !inputData.inboundId) return inputData.result ?? { status: 'silent' as const, reason: 'skipped' };
    const { buyerId, inboundId } = inputData;
    return withBuyerLock(buyerId, () => respond(buyerId, inboundId));
  },
});

export const inboundWorkflow = createWorkflow({
  id: 'handle-inbound',
  description: 'One inbound buyer email in, at most one validated reply out, in the same thread.',
  inputSchema: inboundSchema,
  outputSchema: resultSchema,
})
  .then(intakeStep)
  .then(respondStep)
  .commit();

/**
 * Runs the handle-inbound workflow for one email. If the workflow engine itself fails,
 * the same two steps run directly; the message id dedupe makes that safe to repeat.
 */
export async function handleInbound(ev: InboundEmail): Promise<InboundResult> {
  try {
    const run = await inboundWorkflow.createRun();
    const out = await run.start({ inputData: ev });
    if (out.status === 'success') return out.result as InboundResult;
    console.warn(`[inbound] workflow ended with status ${out.status}; running the steps directly`);
  } catch (err) {
    console.warn('[inbound] workflow engine failed; running the steps directly:', (err as Error).message);
  }
  const first = await intake(ev);
  if (!first.proceed) return first.result;
  return withBuyerLock(first.buyerId, () => respond(first.buyerId, first.inboundId));
}

async function handleCraigslistMail(item: Item, ev: InboundEmail): Promise<InboundResult> {
  const text = `${ev.text ?? ''}\n${ev.html ?? ''}`;
  const link = text.match(/https:\/\/post\.craigslist\.org\/[^\s"'<>]+/)?.[0];
  const listing = text.match(/https:\/\/[a-z]+\.craigslist\.org\/[^\s"'<>]+\.html/)?.[0];
  if (listing) await q('update items set craigslist_url = $2 where id = $1', [item.id, listing]);
  if (link) await notifyOwner(`Craigslist needs one tap to publish "${item.title}": ${link}`);
  else if (listing) await notifyOwner(`Craigslist listing is live: ${listing}`);
  return { status: 'silent', reason: 'craigslist' };
}

async function finishInbound(inboundId: string, intent: string, offerCents?: number | null): Promise<void> {
  await q('update messages set intent = $2, offer_cents = $3, handled_at = $4 where id = $1', [inboundId, intent, offerCents ?? null, now()]);
}

async function rescore(buyerId: string): Promise<void> {
  const b = await getBuyer(buyerId);
  if (!b) return;
  const item = await getItem(b.item_id);
  const lastIn = await q1<Message>("select * from messages where buyer_id = $1 and direction = 'in' order by created_at desc limit 1", [buyerId]);
  const prevOut = lastIn
    ? await q1<Message>("select * from messages where buyer_id = $1 and direction = 'out' and body is not null and created_at < $2 order by created_at desc limit 1", [buyerId, lastIn.created_at])
    : undefined;
  const quick = Boolean(lastIn && prevOut && lastIn.created_at.getTime() - prevOut.created_at.getTime() <= 30 * 60_000);
  const score = buyerScore({
    offerCents: b.agreed_cents ?? b.last_offer_cents,
    currentAskCents: item?.ask_cents ?? 0,
    hasConcreteTime: b.proposed_at != null,
    repliedWithin30Min: quick,
    noScamFlags: (b.scam_flags ?? []).length === 0,
  });
  await q('update buyers set score = $2 where id = $1', [buyerId, score]);
}

/** Respond to one stored inbound message. Also the re-entry point after a rate limit or a Telegram decision. */
export async function respond(buyerId: string, inboundId: string, opts: { bypassSuspicious?: boolean } = {}): Promise<InboundResult> {
  const buyer = (await getBuyer(buyerId))!;
  const item = (await getItem(buyer.item_id))!;
  const user = await getUser(item.user_id);
  const inbound = (await q1<Message>('select * from messages where id = $1', [inboundId]))!;
  const body = inbound.body ?? '';
  const ask = item.ask_cents ?? 0;
  const floor = item.floor_cents ?? ask;
  const silent = async (intent: string, reason: string, note?: string): Promise<InboundResult> => {
    await finishInbound(inboundId, intent);
    if (note) await logNote(buyerId, intent, note, floor, ask);
    return { status: 'silent', buyerId, reason };
  };

  if (buyer.status === 'blocked') return silent('scam', 'blocked');
  if (item.status !== 'listed' && item.status !== 'pending') return silent('other', `item_${item.status}`);

  const sentSoFar = await q1<{ n: number }>("select count(*)::int as n from messages where buyer_id = $1 and direction = 'out' and body is not null", [buyerId]);
  if ((sentSoFar?.n ?? 0) >= MAX_REPLIES_PER_BUYER) return silent('other', 'reply_cap', 'Reply cap reached for this buyer. Not answering further.');

  if (!canSendNow(buyer.last_outbound, now(), env.DEMO_MODE)) {
    const pending = await q1("select id from clocks where kind = 'reprocess' and done_at is null and payload->>'buyer_id' = $1", [buyerId]);
    if (!pending) await addClock('reprocess', new Date(buyer.last_outbound!.getTime() + OUTBOUND_COOLDOWN_MS), { buyer_id: buyerId });
    return { status: 'silent', buyerId, reason: 'rate_limited' };
  }

  const windows = parseWindows(user.pickup_windows);
  const slots = upcomingSlots(windows, now(), 3).map(formatSlot);
  const first = extractOfferCents(body, ask);

  // 1. Scam rules run before the model and are decisive.
  const scam = matchScamRules(body, { askCents: ask, offerCents: first.offerCents, pickupOnly: true });
  if (scam.length > 0) {
    await blockBuyerCore(buyerId, scam);
    await finishInbound(inboundId, 'scam', first.offerCents);
    await logNote(buyerId, 'scam', `Blocked, no reply. Matched scam rule: ${scam.map((s) => s.label).join('; ')}.`, floor, ask);
    return { status: 'silent', buyerId, reason: 'scam_blocked' };
  }

  // 2. Classify. Injection is detected by rule; the buyer's text stays text either way.
  const injection = detectInjection(body);
  const ruleTime = parseBuyerTime(body, now(), windows);
  const heuristic = heuristicClassify(body, first.offerCents != null, Boolean(ruleTime), buyer.last_counter_cents != null);
  const lastOut = await q1<Message>("select body from messages where buyer_id = $1 and direction = 'out' and body is not null order by created_at desc limit 1", [buyerId]);
  // The model classifies only what rules cannot read. An explicit offer needs no second opinion,
  // which keeps a lowball at one model call (the reply) when a room writes all at once.
  const cls = injection || first.offerCents != null
    ? heuristic
    : await classifyInbound(body, { nowLocal: formatSlotLong(now()) + ` ${now().getFullYear()}`, lastAgentMessage: lastOut?.body, askDollars: ask / 100 }, heuristic);

  // Henri may have approved a price under the floor for this buyer; that is the only way the minimum moves.
  const approved = await approvedCents(buyerId);
  const minimum = approved != null ? Math.min(floor, approved) : floor;
  const standing = Math.max(minimum, buyer.agreed_cents ?? buyer.last_counter_cents ?? ask);
  let offer = extractOfferCents(body, ask, cls.offerHintCents).offerCents;
  if (offer == null && cls.acceptsOurPrice && !injection) offer = standing;

  let when: BuyerTime | undefined = ruleTime;
  if (!when && cls.proposedTimeIso) {
    const d = new Date(cls.proposedTimeIso);
    if (!Number.isNaN(d.getTime()) && d.getTime() > now().getTime() && d.getTime() < now().getTime() + 21 * DAY_MS) {
      when = { date: d, insideWindows: isInsideWindows(d, windows) };
    }
  }

  await q(
    `update buyers set last_offer_cents = coalesce($2, last_offer_cents), proposed_time = coalesce($3, proposed_time), proposed_at = coalesce($4, proposed_at) where id = $1`,
    [buyerId, offer ?? null, when ? formatSlotLong(when.date) : cls.proposedTimeText ?? null, when?.date ?? null],
  );
  const intent = cls.intent === 'scam' ? 'other' : cls.intent;

  // 3. Borderline scam: the model is suspicious but no rule matched. Henri decides.
  if (cls.suspicious && !opts.bypassSuspicious && !injection) {
    await createDecision({
      kind: 'scam_unsure',
      itemId: item.id,
      buyerId,
      payload: { message_id: inboundId, offer_cents: offer ?? null, reason: cls.suspiciousReason ?? 'the message looks off' },
      options: [
        { key: 'block', label: 'Block' },
        { key: 'fine', label: "It's fine" },
      ],
      text: tpl.scamUnsure(offer, cls.suspiciousReason ?? 'the message looks off'),
    });
    await finishInbound(inboundId, 'scam', offer);
    await logNote(buyerId, 'scam', `Held, no reply yet. Looks suspicious (${cls.suspiciousReason ?? 'no rule matched'}). Asked Henri on Telegram.`, floor, ask);
    await rescore(buyerId);
    return { status: 'silent', buyerId, reason: 'scam_unsure' };
  }

  const send = async (text: string, kind: string, reasoning: string, priceCents: number | null): Promise<InboundResult> => {
    const sent = await replyInThread({ inboxId: item.inbox_id!, lastInboundMessageId: inbound.agentmail_message_id, to: buyer.email, subject: item.title }, text);
    await finishInbound(inboundId, intent, offer);
    await logOutbound({ buyerId, body: text, intent: kind, reasoning, offerCents: priceCents, floorCents: floor, askCents: ask, agentmailMessageId: sent.messageId });
    await rescore(buyerId);
    return { status: 'replied', buyerId, kind, text };
  };

  // 4. Prompt injection: no model in the loop at all. The number is whatever code says stands.
  if (injection) {
    return send(
      injectionReply(standing, slots),
      'injection',
      `Prompt injection in the buyer's text, treated as text. Price is decided in code, so ${dollars(standing)} stands.`,
      standing,
    );
  }

  // 5. Code decides the numbers.
  const best = await q1<{ cents: number | null }>(
    "select max(coalesce(agreed_cents, last_offer_cents)) as cents from buyers where item_id = $1 and id <> $2 and status in ('active','confirmed','backup') and coalesce(agreed_cents, last_offer_cents) >= $3",
    [item.id, buyerId, floor],
  );
  const others = await q1<{ n: number }>(
    "select count(*)::int as n from buyers where item_id = $1 and id <> $2 and status <> 'blocked' and last_inbound > $3",
    [item.id, buyerId, new Date(now().getTime() - DAY_MS)],
  );
  const bestOther = best?.cents ?? null;
  const mayMention = mayMentionOtherInterest(others?.n ?? 0);
  const slot = await activeSlot(item.id);
  const mine = slot && slot.buyer_id === buyerId ? slot : undefined;
  const pendingOther = Boolean(slot && slot.buyer_id !== buyerId);

  let decision: Decision = decide({
    currentAskCents: ask,
    floorCents: floor,
    offerCents: offer,
    countersUsed: buyer.counters_used,
    lastCounterCents: buyer.last_counter_cents,
    agreedCents: buyer.agreed_cents,
    bestOtherOfferCents: bestOther,
    belowFloorApproved: offer != null && approved != null && offer >= approved,
  });

  let kind: ReplyKind;
  let reason: string;
  let slotTime: string | undefined;
  let addressAllowed = false;
  const offerText = offer != null ? dollars(offer) : 'none';

  if (mine) {
    // The buyer who holds the slot is writing again. The deal stands; nothing is renegotiated.
    const agreed = buyer.agreed_cents ?? standing;
    decision = { action: 'answer', priceCents: agreed, final: false };
    slotTime = formatSlotLong(mine.starts_at);
    addressAllowed = mine.status === 'address_sent' || mine.status === 'reminded';
    if (mine.status !== 'confirmed') await q('update slots set buyer_confirmed_at = $2 where id = $1 and buyer_confirmed_at is null', [mine.id, now()]);
    const asksAddress = /\b(address|where (are|is|do|should)|location|directions)\b/i.test(body);
    kind = asksAddress && !addressAllowed ? 'address_gate' : 'confirmed_followup';
    reason = kind === 'address_gate' ? 'Asked for the address before the address clock. Address goes out two hours before pickup, always.' : `Confirmed buyer writing again. Deal stands at ${dollars(agreed)}, ${slotTime}.`;
  } else if (decision.action === 'accept_conditional' || (decision.action === 'answer' && buyer.agreed_cents != null && when)) {
    const price = decision.action === 'accept_conditional' ? decision.priceCents : buyer.agreed_cents!;
    const accepted = await acceptOfferCore(buyerId, price);
    if (!accepted.ok) {
      // Cannot happen for an offer at or above the floor; if it does, hold the floor.
      decision = { action: 'counter', priceCents: floor, final: true };
      kind = 'counter_final';
      reason = `acceptOffer refused (${accepted.reason}). Holding ${dollars(floor)}.`;
    } else if (pendingOther) {
      await q("update buyers set status = 'backup' where id = $1 and status = 'active'", [buyerId]);
      return send(PENDING_REPLY, 'backup', `Offer ${dollars(price)} is at or above the floor, but the item is pending with another buyer. Added to the backup queue.`, price);
    } else if (when?.insideWindows) {
      const booked = await scheduleSlotCore(buyerId, when.date);
      decision = { action: 'accept_conditional', priceCents: price, final: false };
      if (booked.ok) {
        kind = 'slot_confirmed';
        slotTime = formatSlotLong(when.date);
        reason = `Offer ${dollars(price)} is at or above the floor. Accepted through acceptOffer. ${slotTime} is inside the pickup windows, slot confirmed.`;
      } else {
        kind = 'accept_needs_time';
        reason = `Offer ${dollars(price)} accepted, but the slot could not be booked (${booked.reason}). Asking for another time.`;
      }
    } else if (when) {
      decision = { action: 'accept_conditional', priceCents: price, final: false };
      kind = 'slot_conflict';
      slotTime = formatSlotLong(when.date);
      reason = `Offer ${dollars(price)} accepted. ${slotTime} is outside the pickup windows. Asked Henri on Telegram.`;
      await createDecision({
        kind: 'slot_conflict',
        itemId: item.id,
        buyerId,
        payload: { starts_at: when.date.toISOString(), offer_cents: price },
        options: [
          { key: 'allow', label: 'Allow' },
          { key: 'decline', label: 'Decline' },
        ],
        text: tpl.slotConflict(price, slotTime),
      });
    } else {
      decision = { action: 'accept_conditional', priceCents: price, final: false };
      kind = 'accept_needs_time';
      reason = `Offer ${dollars(price)} is at or above the floor${bestOther != null ? ' and within 5% of the best other offer' : ''}. Accepted through acceptOffer, conditional on a pickup slot.`;
    }
  } else if (decision.action === 'counter') {
    kind = decision.final ? 'counter_final' : 'counter';
    const counted = buyer.counters_used < MAX_COUNTERS;
    await q('update buyers set counters_used = counters_used + $2, last_counter_cents = $3 where id = $1', [buyerId, counted ? 1 : 0, decision.priceCents]);
    reason = decision.final
      ? `Offer ${offerText} is below the floor after ${buyer.counters_used} counter${buyer.counters_used === 1 ? '' : 's'}. Holding ${dollars(decision.priceCents)}, marked final.`
      : `Offer ${offerText} is below the floor. Countering at ${dollars(decision.priceCents)} (midpoint of ask and offer, never under the floor)${when ? '. Buyer is concrete on time' : ''}.`;
    // A serious buyer stuck under the floor after the final counter: one of the decisions only Henri can make.
    if (decision.final && !counted && offer != null && offer >= floor * 0.7) {
      const mid = roundTo5((offer + floor) / 2);
      await createDecision({
        kind: 'below_floor',
        itemId: item.id,
        buyerId,
        payload: { offer_cents: offer, mid_cents: mid, floor_cents: floor },
        options: [
          { key: 'take_it', label: 'Take it' },
          { key: 'hold_floor', label: 'Hold floor' },
          { key: 'counter_mid', label: `Counter ${dollars(mid)}` },
        ],
        text: tpl.belowFloor({ offerCents: offer, floorCents: floor, when: when ? formatSlotLong(when.date) : buyer.proposed_time, others: others?.n ?? 0, bestOtherCents: bestOther }),
      });
    }
  } else if (decision.action === 'match_higher') {
    kind = 'match_higher';
    reason = `Offer ${offerText} is above the floor but clearly below a real higher offer (${dollars(decision.priceCents)}). Asking them to match it.`;
  } else {
    kind = 'answer';
    reason = `No offer in this message (${intent}). Stating the standing price ${dollars(decision.priceCents)} and the pickup slots.`;
  }

  // 6. The model writes the words; code validates them.
  const thread = await q<Pick<Message, 'direction' | 'body'>>(
    'select direction, body from messages where buyer_id = $1 and body is not null and id <> $2 order by created_at desc limit 6',
    [buyerId, inboundId],
  );
  const needsNumber = kind !== 'confirmed_followup' && kind !== 'address_gate' && kind !== 'answer';
  const brief: Brief = {
    buyerId,
    kind,
    priceCents: decision.priceCents,
    itemTitle: item.title ?? 'the item',
    conditionNotes: item.condition_notes,
    listing: item.description,
    neighborhood: user.neighborhood,
    paymentMethods: user.payment_methods,
    buyerBody: body,
    thread: thread.reverse(),
    slots,
    slotTime,
    mayMentionOtherInterest: mayMention,
    bestOtherOfferCents: bestOther,
    rules: {
      floorCents: floor,
      minAllowedCents: Math.min(floor, decision.priceCents),
      requiredCents: needsNumber ? decision.priceCents : undefined,
      bestOtherOfferCents: kind === 'match_higher' ? bestOther : null,
      mayMentionOtherInterest: mayMention,
      addressAllowed,
      meetingSpot: user.meeting_spot,
    },
  };
  const written = await writeReply(brief);
  // The negotiator may call blockBuyer on a clear scam the rules missed. A blocked buyer gets no reply.
  if ((await getBuyer(buyerId))?.status === 'blocked') {
    await finishInbound(inboundId, 'scam', offer);
    await logNote(buyerId, 'scam', 'Blocked by the negotiator as a scam the rules did not catch. No reply.', floor, ask);
    return { status: 'silent', buyerId, reason: 'scam_blocked' };
  }
  // Belt and braces: whatever wrote it, nothing below the allowed minimum leaves.
  const finalCheck = validateReply(written.text, { floorCents: floor, minAllowedCents: brief.rules.minAllowedCents });
  if (!finalCheck.ok) throw new Error(`refusing to send a reply that fails validation: ${finalCheck.reasons.join('; ')}`);

  // The board shows why the number is what it is. That is code's reasoning; the model only chose the words.
  const reasoning = reason;
  const suffix = written.rejected.length > 0 ? ` (${written.rejected.length} draft${written.rejected.length === 1 ? '' : 's'} rejected by validation${written.source === 'template' ? ', sent the template' : ''})` : '';
  return send(written.text, kind, reasoning + suffix, decision.priceCents);
}

export const _internals = { firstName };
