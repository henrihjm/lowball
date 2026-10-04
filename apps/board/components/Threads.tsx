'use client';

import { fmtTime, intentLabel, usd } from '@/lib/format';
import type { BoardMessage, BuyerThread } from '@/lib/types';
import { Chip, Why } from './bits';

/** Panel 1: one card per buyer, newest activity first, the judgment beside every reply. */
export function LiveThreads({ threads, busy }: { threads: BuyerThread[]; busy: boolean }) {
  const live = threads.filter((t) => t.status !== 'blocked');
  return (
    <section className="panel panel--threads" aria-labelledby="threads-h">
      <header className="panel__head">
        <h2 id="threads-h">Live threads</h2>
        <span className="panel__hint">{live.length === 1 ? '1 buyer' : `${live.length} buyers`}</span>
      </header>
      {live.length === 0 ? (
        <p className="empty">No buyer has written yet.</p>
      ) : (
        <ol className="threads">
          {live.map((t) => (
            <li key={t.buyerId}>
              <ThreadCard thread={t} busy={busy} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function ThreadCard({ thread, busy }: { thread: BuyerThread; busy: boolean }) {
  const tail = thread.messages[thread.messages.length - 1];
  const pending = busy && tail?.direction === 'in';
  return (
    <article className="tcard">
      <header className="tcard__head">
        <span className="tcard__name">{thread.name}</span>
        <span className="tcard__email">{thread.email}</span>
        <Chip status={thread.status} />
      </header>
      <div className="msgs">
        {thread.messages.map((m) => (
          <MessageRow key={m.id} m={m} name={thread.name} />
        ))}
        {pending && (
          <div className="msg msg--out msg--pending">
            <span className="msg__who">Lowball</span>
            <p className="msg__text">Writing a reply</p>
          </div>
        )}
      </div>
    </article>
  );
}

function MessageRow({ m, name }: { m: BoardMessage; name: string }) {
  if (m.direction === 'in') {
    return (
      <div className="msg msg--in">
        <span className="msg__who">{name}</span>
        <p className="msg__text">{m.body}</p>
        <time className="msg__time" dateTime={m.at}>
          {fmtTime(m.at)}
        </time>
      </div>
    );
  }
  return (
    <div className={m.body ? 'msg msg--out' : 'msg msg--out msg--note'}>
      <span className="msg__who">Lowball</span>
      <p className="msg__text">{m.body ?? 'No reply sent.'}</p>
      <Why m={m} />
    </div>
  );
}

interface Exchange {
  key: string;
  thread: BuyerThread;
  inbound: BoardMessage | null;
  out: BoardMessage | null;
  at: number;
}

/** Every agent reply paired with the buyer message it answers, newest first. */
function exchanges(threads: BuyerThread[], busy: boolean): Exchange[] {
  const list: Exchange[] = [];
  for (const thread of threads) {
    let lastIn: BoardMessage | null = null;
    for (const m of thread.messages) {
      if (m.direction === 'in') {
        lastIn = m;
        continue;
      }
      list.push({ key: m.id, thread, inbound: lastIn, out: m, at: Date.parse(m.at) });
      lastIn = null;
    }
    if (lastIn && busy && thread.status !== 'blocked') {
      list.push({ key: lastIn.id, thread, inbound: lastIn, out: null, at: Date.parse(lastIn.at) });
    }
  }
  return list.sort((a, b) => b.at - a.at);
}

/** Room view: one reply per row, big type, floor in the accent color. */
export function RoomFeed({ threads, busy }: { threads: BuyerThread[]; busy: boolean }) {
  const rows = exchanges(threads, busy).slice(0, 12);
  if (rows.length === 0) {
    return (
      <section className="feed" aria-label="Live replies">
        <p className="feed__empty">Waiting for the first offer.</p>
      </section>
    );
  }
  return (
    <section className="feed" aria-label="Live replies">
      <ol>
        {rows.map((x) => {
          const blocked = x.thread.status === 'blocked';
          const label = intentLabel(x.out?.intent);
          return (
            <li key={x.key} className={blocked ? 'x x--blocked' : 'x'}>
              <div className="x__main">
                <p className="x__in">
                  <span className="x__name">{x.thread.name}</span>
                  {x.inbound?.body && <span className="x__said">{x.inbound.body}</span>}
                </p>
                {x.out ? (
                  <p className={x.out.body ? 'x__reply' : 'x__reply x__reply--none'}>{x.out.body ?? (blocked ? 'Blocked. No reply.' : 'No reply sent.')}</p>
                ) : (
                  <p className="x__reply x__reply--pending">Writing a reply</p>
                )}
                {x.out?.reasoning && <p className="x__why">{x.out.reasoning}</p>}
              </div>
              <div className="x__side">
                {blocked ? (
                  <div className="tags">
                    {(x.thread.scamFlags.length ? x.thread.scamFlags : [{ rule: 'blocked', label: 'Blocked' }]).map((f) => (
                      <span key={f.rule} className="tag tag--danger">
                        {f.label}
                      </span>
                    ))}
                  </div>
                ) : (
                  <>
                    {x.out?.floorCents != null && <span className="x__floor">floor {usd(x.out.floorCents)}</span>}
                    {label && <span className="x__intent">{label}</span>}
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
