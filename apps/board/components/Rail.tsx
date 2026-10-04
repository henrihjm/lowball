'use client';

import type { CSSProperties } from 'react';
import { fmtTime, usd } from '@/lib/format';
import type { BuyerRow, BuyerThread, TelegramLine } from '@/lib/types';
import { Chip } from './bits';

// 0.6 * min(offer / ask, 1.1) + 0.4 * reliability tops out at 1.06.
const MAX_SCORE = 1.06;

/** Panel 2: buyers ranked by score. The API already sorts them. */
export function Buyers({ buyers }: { buyers: BuyerRow[] }) {
  return (
    <section className="panel" aria-labelledby="buyers-h">
      <header className="panel__head">
        <h2 id="buyers-h">Buyers</h2>
        <span className="panel__hint">ranked by score</span>
      </header>
      {buyers.length === 0 ? (
        <p className="empty">Nobody yet.</p>
      ) : (
        <ol className="buyers">
          {buyers.map((b, i) => {
            const offer = b.agreedCents ?? b.lastOfferCents;
            const pct = Math.max(0, Math.min(100, Math.round((b.score / MAX_SCORE) * 100)));
            return (
              <li key={b.id} className="buyer">
                <span className="buyer__rank">{i + 1}</span>
                <span className="buyer__who">
                  <span className="buyer__top">
                    <span className="buyer__name">{b.name}</span>
                    <Chip status={b.status} />
                  </span>
                  <span className="buyer__time">{b.proposedTime ?? 'no time yet'}</span>
                </span>
                <span className="buyer__offer">{offer != null ? usd(offer) : 'no offer'}</span>
                <span className="buyer__score" title={`Score ${b.score.toFixed(2)}`}>
                  <span className="buyer__bar" style={{ '--pct': `${pct}%` } as CSSProperties} />
                  {b.score.toFixed(2)}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/** The Blocked column: who was stopped, and the rule that matched. */
export function Blocked({ threads }: { threads: BuyerThread[] }) {
  const blocked = threads.filter((t) => t.status === 'blocked');
  return (
    <section className="panel" aria-labelledby="blocked-h">
      <header className="panel__head">
        <h2 id="blocked-h">Blocked</h2>
        <span className="panel__hint">{blocked.length === 1 ? '1 scam' : `${blocked.length} scams`}</span>
      </header>
      {blocked.length === 0 ? (
        <p className="empty">No scams so far.</p>
      ) : (
        <ol className="blockedList">
          {blocked.map((t) => {
            const said = [...t.messages].reverse().find((m) => m.direction === 'in' && m.body);
            const note = [...t.messages].reverse().find((m) => m.direction === 'out' && m.reasoning);
            const flags = t.scamFlags.length ? t.scamFlags : [{ rule: 'blocked', label: 'Blocked' }];
            return (
              <li key={t.buyerId} className="blocked">
                <div className="blocked__head">
                  <span className="blocked__name">{t.name}</span>
                  <span className="blocked__email">{t.email}</span>
                </div>
                <div className="tags">
                  {flags.map((f) => (
                    <span key={f.rule} className="tag tag--danger">
                      {f.label}
                    </span>
                  ))}
                </div>
                {said && <p className="blocked__quote">&ldquo;{said.body}&rdquo;</p>}
                {note && <p className="blocked__why">{note.reasoning}</p>}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/** What reached Henri on Telegram. This short list is the whole user experience. */
export function TelegramTail({ lines }: { lines: TelegramLine[] }) {
  return (
    <section className="panel" aria-labelledby="tg-h">
      <header className="panel__head">
        <h2 id="tg-h">Telegram</h2>
        <span className="panel__hint">all Henri sees</span>
      </header>
      {lines.length === 0 ? (
        <p className="empty">Nothing sent to Henri yet.</p>
      ) : (
        <ol className="tg">
          {lines.map((line, i) => (
            <li key={`${line.at}-${i}`} className="tg__line">
              <p className="tg__text">{line.text}</p>
              {line.buttons && line.buttons.length > 0 && (
                <div className="tg__buttons">
                  {line.buttons.map((b) => (
                    <span key={b.data} className="tg__btn">
                      {b.text}
                    </span>
                  ))}
                </div>
              )}
              <time className="tg__time" dateTime={line.at}>
                {fmtTime(line.at)}
              </time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
