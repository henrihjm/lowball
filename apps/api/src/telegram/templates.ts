// Every message Henri sees on Telegram. Short sentences, no em dashes.
import { dollars } from '../policy/pricing.js';
import type { Button } from './notify.js';

export const onboarding =
  "Hi. Three things and I'll remember them: 1) your pickup neighborhood, 2) your usual pickup windows (e.g. weekday evenings 6 to 8), 3) how you take money (cash, Venmo @handle). Reply in one message.";

export const onboardingSaved = (neighborhood: string, windows: string, payment: string) =>
  `Saved. Pickup in ${neighborhood}, ${windows}, ${payment}. Send me a photo of anything you want gone.`;

export const decisionButton = (decisionId: string, key: string, text: string): Button => ({ text, data: `d:${decisionId}:${key}` });

export interface ProposalCard {
  title: string;
  conditionLine: string;
  loCents: number;
  hiCents: number;
  n: number;
  askCents: number;
  floorCents: number;
  decayPct: number;
  decayEveryDays: number;
  windows: string;
  neighborhood: string;
  listing: string;
}

export function proposalCard(p: ProposalCard): string {
  return [
    `${p.title}, ${p.conditionLine}`,
    `Sold recently for ${dollars(p.loCents)} to ${dollars(p.hiCents)} near you (${p.n} comps).`,
    `Ask ${dollars(p.askCents)} · Floor ${dollars(p.floorCents)} · drops ${p.decayPct}% every ${p.decayEveryDays} days to floor`,
    `Pickup ${p.windows}, ${p.neighborhood}`,
    `Listing: "${p.listing}"`,
  ].join('\n');
}

export const proposalButtons = (itemId: string): Button[] => [
  { text: 'Post it', data: `i:${itemId}:post` },
  { text: 'Change price', data: `i:${itemId}:price` },
  { text: 'Edit text', data: `i:${itemId}:text` },
];

/** Fewer than 3 comps: ask Henri for a price instead of inventing one. */
export const needsPriceCard = (title: string, conditionLine: string, n: number) =>
  `${title}, ${conditionLine}\nI found ${n === 0 ? 'no' : `only ${n}`} comparable sale${n === 1 ? '' : 's'}, so I won't guess a price. Reply with your ask and floor, e.g. "220 floor 160".`;

export const afterPost = (inbox: string) => `Posted. Buyers write to ${inbox}. I'll handle them and only message you for a decision.`;
export const afterPostManual = (inbox: string) =>
  `Listing text and photos are ready. Post it on Craigslist with contact email ${inbox}; I'll handle everything from there.`;

export const belowFloor = (p: { offerCents: number; floorCents: number; when?: string | null; others: number; bestOtherCents?: number | null }) =>
  `Offer ${dollars(p.offerCents)} (floor ${dollars(p.floorCents)}) from a buyer who can pick up ${p.when || 'at a time to be agreed'}. ${p.others} other inquir${p.others === 1 ? 'y' : 'ies'}, best other ${p.bestOtherCents != null ? dollars(p.bestOtherCents) : 'none'}.`;

export const slotConflict = (offerCents: number, time: string) => `Best buyer (${dollars(offerCents)}) can only do ${time}, outside your windows.`;

export const scamUnsure = (offerCents: number | null | undefined, reason: string) =>
  `Buyer ${offerCents != null ? `offers ${dollars(offerCents)}` : 'wrote in'} but ${reason}. Looks like a scam.`;

export const noshow = (name: string, time: string, backup?: { cents: number | null; when?: string | null }) =>
  `${name} didn't show at ${time} and isn't answering.${backup ? ` Backup (${dollars(backup.cents)}, ${backup.when || 'time open'}).` : ' No backup in the queue.'}`;

export const soldCheck = (name: string, item: string) => `Did ${name} pick up the ${item}?`;

export const dayOf = (p: { time: string; name: string; cents: number; payment: string; addressAt: string; remindAt: string }) =>
  `Pickup today ${p.time}, ${p.name}, ${dollars(p.cents)} ${p.payment}. I'll send the address at ${p.addressAt} and remind them at ${p.remindAt}.`;

export const pickupBooked = (name: string, cents: number, time: string) => `Pickup booked: ${name}, ${dollars(cents)}, ${time}.`;

export const soldSummary = (p: { delisted: boolean; cents: number; inquiries: number; lowballs: number; scams: number; noshows: number; days: number }) =>
  `${p.delisted ? 'Delisted. ' : ''}Sold ${dollars(p.cents)} after ${p.inquiries} inquir${p.inquiries === 1 ? 'y' : 'ies'}, ${p.lowballs} lowball${p.lowballs === 1 ? '' : 's'}, ${p.scams} scam${p.scams === 1 ? '' : 's'} blocked, ${p.noshows} no-show${p.noshows === 1 ? '' : 's'}. ${p.days} day${p.days === 1 ? '' : 's'}.`;

export const digest = (p: { item: string; day: number; inquiries: number; lowballs: number; scams: number; bestCents?: number | null; slotStatus: string; backups: number; askCents: number; until: string }) =>
  `${p.item}, day ${p.day}. ${p.inquiries} inquir${p.inquiries === 1 ? 'y' : 'ies'} · ${p.lowballs} lowball${p.lowballs === 1 ? '' : 's'} countered · ${p.scams} scam${p.scams === 1 ? '' : 's'} blocked · best offer ${p.bestCents != null ? dollars(p.bestCents) : 'none'} (${p.slotStatus}) · ${p.backups} in backup. Price ${dollars(p.askCents)} until ${p.until}.`;
