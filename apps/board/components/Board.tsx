'use client';

import { useEffect, useState } from 'react';
import { useBoardState, type Conn } from '@/lib/useBoardState';
import type { BoardState } from '@/lib/types';
import { ItemHeader, RoomHero } from './ItemHeader';
import { OperatorChat } from './OperatorChat';
import { Blocked, Buyers, TelegramTail } from './Rail';
import { LiveThreads, RoomFeed } from './Threads';
import { Wordmark } from './Wordmark';

const CONN_LABEL: Record<Conn, string> = {
  loading: 'connecting',
  live: 'live',
  offline: 'API offline',
  unauthorized: 'token rejected',
  error: 'API error',
};

function notice(conn: Conn, hasState: boolean): string | null {
  const tail = hasState ? ' Showing the last state.' : '';
  if (conn === 'offline') return `Can't reach the Lowball API. Start it with "pnpm dev" in the repo root.${tail}`;
  if (conn === 'unauthorized') return `The API rejected the board token. Check LOWBALL_API_TOKEN in the root .env.${tail}`;
  if (conn === 'error') return `The API returned an error. Retrying.${tail}`;
  return null;
}

export function Board() {
  // Read once on the client: ?mock=1 serves sample data, ?room=1 opens the room view.
  const [flags, setFlags] = useState({ ready: false, mock: false });
  const [room, setRoom] = useState(false);
  const [itemId, setItemId] = useState<string | undefined>();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setFlags({ ready: true, mock: params.get('mock') === '1' });
    if (params.get('room') === '1') setRoom(true);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return;
      if (e.key === 'r' || e.key === 'R') setRoom((v) => !v);
      else if (e.key === 'Escape') setRoom(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const { state, conn, now, refresh } = useBoardState({ enabled: flags.ready, itemId, mock: flags.mock, intervalMs: room ? 1000 : 2000 });
  const problem = notice(conn, state != null);
  const busy = state ? state.queue.running + state.queue.waiting > 0 : false;

  return (
    <div className={room ? 'board board--room' : 'board'}>
      {!room && (
        <aside className="side" aria-label="Operator chat">
          <header className="side__head">
            <Wordmark />
          </header>
          <OperatorChat onReply={refresh} mock={flags.mock} />
        </aside>
      )}

      <main className="main">
        <TopBar state={state} conn={conn} room={room} onRoom={() => setRoom((v) => !v)} itemId={itemId} onItem={setItemId} />
        {problem && (
          <p className="notice" role="status">
            {problem}
          </p>
        )}

        {!state ? (
          !problem && <p className="blank">Connecting to the agent.</p>
        ) : !state.item ? (
          <p className="blank">Nothing listed yet. Send a photo to the Lowball bot on Telegram and tap Post.</p>
        ) : room ? (
          <>
            <RoomHero item={state.item} now={now} />
            <RoomFeed threads={state.threads} busy={busy} />
          </>
        ) : (
          <>
            <ItemHeader item={state.item} now={now} />
            <div className="cols">
              <LiveThreads threads={state.threads} busy={busy} />
              <div className="rail">
                <Buyers buyers={state.buyers} />
                <Blocked threads={state.threads} />
                <TelegramTail lines={state.telegram} />
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

interface TopBarProps {
  state: BoardState | null;
  conn: Conn;
  room: boolean;
  onRoom: () => void;
  itemId: string | undefined;
  onItem: (id: string | undefined) => void;
}

function TopBar({ state, conn, room, onRoom, itemId, onItem }: TopBarProps) {
  const queue = state?.queue;
  const working = queue ? queue.running + queue.waiting : 0;
  return (
    <div className="top">
      {room && <Wordmark />}
      <span className={`conn conn--${conn}`}>
        <i aria-hidden="true" />
        {CONN_LABEL[conn]}
      </span>
      {state?.sample && <span className="pill pill--warn">sample data</span>}
      {queue && working > 0 && (
        <span className="pill pill--busy">
          answering {queue.running}
          {queue.waiting > 0 ? `, ${queue.waiting} waiting` : ''}
        </span>
      )}
      <span className="top__spacer" />
      {!room && state && state.items.length > 1 && (
        <select className="select" aria-label="Item" value={itemId ?? state.item?.id ?? ''} onChange={(e) => onItem(e.target.value || undefined)}>
          {state.items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.title ?? 'Untitled'} ({i.status})
            </option>
          ))}
        </select>
      )}
      <button type="button" className="btn" onClick={onRoom} aria-pressed={room} title="Toggle room view (R)">
        {room ? 'Exit room view' : 'Room view'}
      </button>
    </div>
  );
}
