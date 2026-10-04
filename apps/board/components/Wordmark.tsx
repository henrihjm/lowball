'use client';

import { useCallback, useEffect, useRef } from 'react';

// Same geometry and motion as the owner app's wordmark (BRAND and SWING in apps/api/src/listings.ts).
const L = 40;
const Y = -40;

/** "Low" + a wrecking ball on a bending wire + "all". It swings on open and on click, at no other time. */
export function Wordmark() {
  const wire = useRef<SVGPathElement>(null);
  const ball = useRef<SVGCircleElement>(null);
  const raf = useRef(0);

  const swing = useCallback((amp: number) => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    cancelAnimationFrame(raf.current);
    let t0 = 0;
    const draw = (th: number, om: number) => {
      const x = L * Math.sin(th);
      const y = Y + L * Math.cos(th);
      const cx = x * 0.5 - om * 2.4;
      const cy = Y + (y - Y) * 0.55;
      wire.current?.setAttribute('d', `M0,${Y} Q${cx.toFixed(2)},${cy.toFixed(2)} ${x.toFixed(2)},${y.toFixed(2)}`);
      ball.current?.setAttribute('cx', x.toFixed(2));
      ball.current?.setAttribute('cy', y.toFixed(2));
    };
    const frame = (now: number) => {
      if (!t0) t0 = now;
      const t = (now - t0) / 1000;
      const k = 0.95;
      const w = 5.4;
      const e = amp * Math.exp(-k * t);
      draw(e * Math.cos(w * t), (e * (-k * Math.cos(w * t) - w * Math.sin(w * t))) / w);
      if (e > 0.004) {
        raf.current = requestAnimationFrame(frame);
      } else {
        draw(0, 0);
        raf.current = 0;
      }
    };
    raf.current = requestAnimationFrame(frame);
  }, []);

  useEffect(() => {
    swing(0.75);
    return () => cancelAnimationFrame(raf.current);
  }, [swing]);

  return (
    <span className="brand" role="img" aria-label="Lowball">
      <span aria-hidden="true">Low</span>
      <svg className="wb" viewBox="-8 -7 16 14" aria-hidden="true" onClick={() => swing(0.85)}>
        <path ref={wire} d="M0,-40 Q0,-20 0,0" />
        <circle ref={ball} cx="0" cy="0" r="7" />
      </svg>
      <span aria-hidden="true">all</span>
    </span>
  );
}
