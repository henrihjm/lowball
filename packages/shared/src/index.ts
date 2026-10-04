// Types and zod schemas shared by the API and the board.
import { z } from 'zod';

export const itemStatus = z.enum(['draft', 'listed', 'pending', 'sold', 'paused', 'deleted']);
export const buyerStatus = z.enum(['active', 'blocked', 'confirmed', 'backup', 'noshow', 'closed']);
export const slotStatus = z.enum(['proposed', 'confirmed', 'address_sent', 'reminded', 'completed', 'noshow']);
export const decisionKind = z.enum(['below_floor', 'slot_conflict', 'scam_unsure', 'noshow', 'sold_check']);
export const scamFlag = z.object({ rule: z.string(), label: z.string() });

export const threadMessage = z.object({
  id: z.string(),
  direction: z.enum(['in', 'out']),
  /** null on a reasoning-only note: the agent decided not to reply (blocked, held for Henri). */
  body: z.string().nullable(),
  intent: z.string().nullable(),
  reasoning: z.string().nullable(),
  offerCents: z.number().nullable(),
  floorCents: z.number().nullable(),
  askCents: z.number().nullable(),
  at: z.string(),
});

export const boardState = z.object({
  clock: z.object({ now: z.string(), rate: z.number(), compressing: z.boolean(), mode: z.string(), manual: z.boolean() }),
  demoMode: z.boolean(),
  queue: z.object({ running: z.number(), waiting: z.number() }),
  items: z.array(z.object({ id: z.string(), title: z.string().nullable(), status: itemStatus })),
  telegram: z.array(z.object({ text: z.string(), at: z.string(), buttons: z.array(z.object({ text: z.string(), data: z.string() })).optional() })),
  item: z
    .object({
      id: z.string(),
      title: z.string().nullable(),
      status: itemStatus,
      description: z.string().nullable(),
      askCents: z.number().nullable(),
      floorCents: z.number().nullable(),
      decayPct: z.number(),
      decayEveryDays: z.number(),
      nextDecayAt: z.string().nullable(),
      listedAt: z.string().nullable(),
      soldCents: z.number().nullable(),
      inboxAddress: z.string().nullable(),
      craigslistUrl: z.string().nullable(),
      kernelLiveViewUrl: z.string().nullable(),
      hasPhoto: z.boolean(),
      stats: z.object({ inquiries: z.number(), lowballs: z.number(), scams: z.number(), noshows: z.number(), backups: z.number(), bestCents: z.number().nullable() }),
      slot: z
        .object({ startsAt: z.string(), status: slotStatus, buyerName: z.string().nullable(), agreedCents: z.number().nullable(), addressAt: z.string(), addressSentAt: z.string().nullable() })
        .nullable(),
    })
    .nullable(),
  buyers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      email: z.string(),
      status: buyerStatus,
      score: z.number(),
      lastOfferCents: z.number().nullable(),
      agreedCents: z.number().nullable(),
      countersUsed: z.number(),
      proposedTime: z.string().nullable(),
      scamFlags: z.array(scamFlag),
    }),
  ),
  threads: z.array(
    z.object({ buyerId: z.string(), name: z.string(), email: z.string(), status: buyerStatus, scamFlags: z.array(scamFlag), lastAt: z.string(), messages: z.array(threadMessage) }),
  ),
});

export type BoardState = z.infer<typeof boardState>;
export type ThreadMessage = z.infer<typeof threadMessage>;
export type ItemStatus = z.infer<typeof itemStatus>;
export type BuyerStatus = z.infer<typeof buyerStatus>;

export const operatorRequest = z.object({ text: z.string().min(1).max(500) });
export const operatorResponse = z.object({ reply: z.string() });
