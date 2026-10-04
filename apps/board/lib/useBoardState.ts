'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BoardState } from './types';

export type Conn = 'loading' | 'live' | 'offline' | 'unauthorized' | 'error';

interface Options {
  enabled: boolean;
  itemId?: string;
  mock: boolean;
  intervalMs: number;
}

/**
 * Polls the board's own /api/state proxy. Keeps the last good state while the API
 * is unreachable, and exposes now(): the API's clock (which runs fast in demo mode),
 * re-anchored on every poll and extrapolated in between.
 */
export function useBoardState({ enabled, itemId, mock, intervalMs }: Options) {
  const [state, setState] = useState<BoardState | null>(null);
  const [conn, setConn] = useState<Conn>('loading');
  const anchor = useRef<{ api: number; perf: number; rate: number } | null>(null);
  const lastKey = useRef('');
  const kick = useRef<() => void>(() => {});

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let inFlight = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ctrl = new AbortController();

    const tick = async (): Promise<void> => {
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      clearTimeout(timer);
      try {
        const params = new URLSearchParams();
        if (itemId) params.set('item', itemId);
        if (mock) params.set('mock', '1');
        const res = await fetch(`/api/state?${params.toString()}`, { cache: 'no-store', signal: ctrl.signal });
        if (stopped) return;
        if (res.ok) {
          const data = (await res.json()) as BoardState;
          if (stopped) return;
          const apiNow = Date.parse(data.clock.now);
          anchor.current = { api: Number.isNaN(apiNow) ? Date.now() : apiNow, perf: performance.now(), rate: data.clock.rate || 1 };
          // clock.now changes on every poll; only re-render when something else did.
          const { clock, ...rest } = data;
          const key = `${JSON.stringify(rest)}|${clock.rate}|${clock.compressing}|${clock.mode}`;
          if (key !== lastKey.current) {
            lastKey.current = key;
            setState(data);
          }
          setConn('live');
        } else {
          const err = (await res.json().catch(() => null)) as { error?: string } | null;
          if (stopped) return;
          setConn(err?.error === 'unauthorized' ? 'unauthorized' : err?.error === 'api_unreachable' ? 'offline' : 'error');
        }
      } catch {
        if (!stopped) setConn('offline');
      } finally {
        inFlight = false;
      }
      if (stopped) return;
      if (again) {
        again = false;
        void tick();
      } else {
        timer = setTimeout(() => void tick(), intervalMs);
      }
    };

    kick.current = () => void tick();
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ctrl.abort();
      kick.current = () => {};
    };
  }, [enabled, itemId, mock, intervalMs]);

  const now = useCallback((): number => {
    const a = anchor.current;
    return a ? a.api + (performance.now() - a.perf) * a.rate : Date.now();
  }, []);

  const refresh = useCallback(() => kick.current(), []);

  return { state, conn, now, refresh };
}

/** Re-render the calling component every `ms` (0 turns it off). For countdowns. */
export function useTicker(ms: number): void {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!ms) return;
    const id = setInterval(() => setN((n) => (n + 1) % 1_000_000), ms);
    return () => clearInterval(id);
  }, [ms]);
}
