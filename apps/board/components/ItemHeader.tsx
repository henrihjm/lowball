'use client';

import { countdown, fmtDay, fmtDayTime, fmtTime, safeHttpUrl, usd } from '@/lib/format';
import type { ItemView } from '@/lib/types';
import { useTicker } from '@/lib/useBoardState';
import { Chip, CopyText } from './bits';

interface Props {
  item: ItemView;
  /** The API clock in ms. Runs fast in demo mode. */
  now: () => number;
}

function useSlotLine(item: ItemView, now: () => number): { pickup: string; address: string } | null {
  const slot = item.slot;
  useTicker(slot && !slot.addressSentAt ? 250 : 0);
  if (!slot) return null;
  const who = [slot.buyerName, slot.agreedCents != null ? usd(slot.agreedCents) : null].filter(Boolean).join(', ');
  const pickup = `Pickup ${fmtDayTime(slot.startsAt)}${who ? `, ${who}` : ''}`;
  if (slot.status === 'completed') return { pickup, address: 'Picked up' };
  if (slot.addressSentAt) return { pickup, address: `Address sent ${fmtTime(slot.addressSentAt)}` };
  const left = Date.parse(slot.addressAt) - now();
  return { pickup, address: left > 0 ? `Address goes out in ${countdown(left)}` : 'Address going out now' };
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function statsLine(item: ItemView): string {
  const s = item.stats;
  const parts = [
    count(s.inquiries, 'inquiry', 'inquiries'),
    `${count(s.lowballs, 'lowball', 'lowballs')} countered`,
    `${count(s.scams, 'scam', 'scams')} blocked`,
    `${s.backups} in backup`,
  ];
  if (s.noshows > 0) parts.push(count(s.noshows, 'no-show', 'no-shows'));
  return parts.join(' · ');
}

/** Panel 3: photo, price now, floor, decay date, listing URL, Kernel live view while posting, slot and address countdown. */
export function ItemHeader({ item, now }: Props) {
  const slot = useSlotLine(item, now);
  const listing = safeHttpUrl(item.craigslistUrl);
  const liveView = item.status === 'draft' || item.status === 'listed' ? safeHttpUrl(item.kernelLiveViewUrl) : null;

  return (
    <section className="item" aria-label="Item">
      <div className="item__top">
        <div className="item__photo">
          {item.hasPhoto ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/api/photo/${item.id}`} alt="" />
          ) : (
            <span aria-hidden="true">{(item.title ?? '?').slice(0, 1).toUpperCase()}</span>
          )}
        </div>

        <div className="item__body">
          <div className="item__titleRow">
            <h1 className="item__title">{item.title ?? 'Untitled item'}</h1>
            <Chip status={item.status} />
          </div>
          <p className="item__links">
            {item.inboxAddress && (
              <span>
                Buyers write to <CopyText text={item.inboxAddress} />
              </span>
            )}
            {listing && (
              <a href={listing} target="_blank" rel="noopener noreferrer">
                Craigslist listing
              </a>
            )}
          </p>
          <p className="item__stats">{statsLine(item)}</p>
        </div>

        <dl className="figures">
          <div className="figure">
            <dt>{item.status === 'sold' ? 'Sold for' : 'Price now'}</dt>
            <dd>{usd(item.status === 'sold' ? (item.soldCents ?? item.askCents) : item.askCents)}</dd>
          </div>
          <div className="figure figure--floor">
            <dt>Floor</dt>
            <dd>{usd(item.floorCents)}</dd>
          </div>
          <div className="figure">
            <dt>Best offer</dt>
            <dd>{usd(item.stats.bestCents)}</dd>
          </div>
          <div className="figure figure--small">
            <dt>Next drop</dt>
            <dd>{item.nextDecayAt ? fmtDay(item.nextDecayAt) : 'none'}</dd>
            <small>
              {item.decayPct}% every {item.decayEveryDays} days, never below floor
            </small>
          </div>
        </dl>
      </div>

      <div className="item__slot">
        {slot ? (
          <>
            <span className="item__pickup">{slot.pickup}</span>
            <span className="item__address">{slot.address}</span>
          </>
        ) : (
          <span className="item__noslot">No pickup booked yet. The address stays private until two hours before a confirmed slot.</span>
        )}
      </div>

      {liveView && (
        <div className="liveview">
          <p className="liveview__label">Posting on Craigslist. Kernel live view.</p>
          <iframe src={liveView} title="Kernel live view" sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" loading="lazy" />
        </div>
      )}
    </section>
  );
}

/** Room view hero: the inbox address, big enough to type from the back row. */
export function RoomHero({ item, now }: Props) {
  const slot = useSlotLine(item, now);
  return (
    <section className="hero" aria-label="Item">
      <p className="hero__kicker">Make an offer. Email</p>
      {item.inboxAddress ? <CopyText text={item.inboxAddress} className="hero__inbox" /> : <p className="hero__inbox hero__inbox--none">Inbox not set yet</p>}
      <div className="hero__row">
        <span className="hero__title">{item.title ?? 'Untitled item'}</span>
        <span className="hero__ask">asking {usd(item.askCents)}</span>
        <span className="hero__floor">floor {usd(item.floorCents)}</span>
      </div>
      <p className="hero__stats">
        {statsLine(item)}
        {slot ? ` · ${slot.pickup} · ${slot.address}` : ''}
      </p>
    </section>
  );
}
