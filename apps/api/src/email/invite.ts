// The one thing Henri gets before a pickup: a calendar invite, sent by email from the item's inbox.
import { AgentMailClient } from 'agentmail';
import { now } from '../demo/clock.js';
import { env } from '../env.js';
import { dollars } from '../policy/pricing.js';

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');

export interface Pickup {
  slotId: string;
  itemTitle: string;
  buyerName: string;
  cents: number;
  startsAt: Date;
  spot?: string | null;
  payment?: string | null;
  inboxId: string;
  inboxAddress: string;
  listingsUrl?: string;
}

export function pickupIcs(p: Pickup, ownerEmail: string): string {
  const end = new Date(p.startsAt.getTime() + 30 * 60_000);
  const description = `${p.buyerName} picks up the ${p.itemTitle} for ${dollars(p.cents)} (${p.payment ?? 'cash'}). Lowball sends them the address two hours before and a reminder one hour before.${p.listingsUrl ? ` ${p.listingsUrl}` : ''}`;
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Lowball//Pickup//EN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${p.slotId}@lowball`,
    `DTSTAMP:${stamp(now())}`,
    `DTSTART:${stamp(p.startsAt)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${esc(`Pickup: ${p.itemTitle}, ${p.buyerName}, ${dollars(p.cents)}`)}`,
    `DESCRIPTION:${esc(description)}`,
    ...(p.spot ? [`LOCATION:${esc(p.spot)}`] : []),
    `ORGANIZER;CN=Lowball:mailto:${p.inboxAddress}`,
    `ATTENDEE;CN=Henri;RSVP=FALSE;PARTSTAT=ACCEPTED:mailto:${ownerEmail}`,
    'STATUS:CONFIRMED',
    'BEGIN:VALARM',
    'TRIGGER:-PT30M',
    'ACTION:DISPLAY',
    'DESCRIPTION:Pickup in 30 minutes',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

/** Returns true when the invite was sent. Never throws: a failed invite must not undo a booked pickup. */
export async function sendPickupInvite(p: Pickup): Promise<boolean> {
  const to = env.OWNER_EMAIL;
  if (!to || !env.AGENTMAIL_API_KEY || p.inboxAddress.endsWith('@sim.lowball')) return false;
  try {
    const client = new AgentMailClient({ apiKey: env.AGENTMAIL_API_KEY });
    await client.inboxes.messages.send(p.inboxId, {
      to,
      subject: `Pickup booked: ${p.itemTitle}, ${p.buyerName}, ${dollars(p.cents)}`,
      text: `${p.buyerName} picks up the ${p.itemTitle} for ${dollars(p.cents)}.\nWhen: ${p.startsAt.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}\nWhere: ${p.spot ?? 'your pickup spot'}\n\nThe invite is attached. I send the buyer the address two hours before and a reminder one hour before.${p.listingsUrl ? `\n\n${p.listingsUrl}` : ''}`,
      attachments: [{ filename: 'pickup.ics', contentType: 'text/calendar; method=REQUEST; charset=UTF-8', content: Buffer.from(pickupIcs(p, to)).toString('base64') }],
    });
    return true;
  } catch (err) {
    console.error('[invite] could not send the calendar invite:', (err as Error).message);
    return false;
  }
}
