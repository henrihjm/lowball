'use client';

import { useEffect, useRef, useState } from 'react';
import { intentLabel, statusLabel, usd } from '@/lib/format';
import type { BoardMessage } from '@/lib/types';

export function Chip({ status }: { status: string }) {
  return <span className={`chip chip--${status}`}>{statusLabel(status)}</span>;
}

/** Click to copy. Used for the inbox address. */
export function CopyText({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard unavailable: the address is still on screen to read
    }
  };

  return (
    <button type="button" className={`copy ${className ?? ''}`} onClick={copy} title="Copy">
      <span className="copy__text">{text}</span>
      <span className="copy__hint" aria-live="polite">{copied ? 'copied' : 'copy'}</span>
    </button>
  );
}

/** The judgment behind a reply: floor (accent), ask, what the agent did, and why. */
export function Why({ m }: { m: BoardMessage }) {
  const label = intentLabel(m.intent);
  return (
    <p className="why">
      {m.floorCents != null && <span className="why__floor">floor {usd(m.floorCents)}</span>}
      {m.askCents != null && <span>ask {usd(m.askCents)}</span>}
      {label && <span className="why__intent">{label}</span>}
      {m.reasoning && <span className="why__reason">reasoning: &ldquo;{m.reasoning}&rdquo;</span>}
    </p>
  );
}
