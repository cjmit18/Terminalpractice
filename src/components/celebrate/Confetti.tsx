import React, { useEffect, useRef, useState } from 'react';

const DURATION_MS = 1400;
const PIECES = 90;

/**
 * A short confetti burst for a finished stage or path. Only shown with the "Lively" setting and
 * never when the system asks for reduced motion (GameLayer checks both). Decorative: hidden from
 * assistive technology, and it never takes clicks.
 */
export const Confetti: React.FC = () => {
  const ref = useRef<HTMLCanvasElement>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const w = (canvas.width = window.innerWidth);
    const h = (canvas.height = window.innerHeight);
    const css = getComputedStyle(document.documentElement);
    const colors = ['--accent', '--ok', '--warn'].map(v => css.getPropertyValue(v).trim() || '#2f5fb8');
    const pieces = Array.from({ length: PIECES }, (_, i) => ({
      x: w / 2 + (Math.random() - 0.5) * w * 0.3,
      y: h * 0.35,
      vx: (Math.random() - 0.5) * 9,
      vy: -Math.random() * 9 - 3,
      size: 4 + Math.random() * 4,
      spin: Math.random() * Math.PI,
      color: colors[i % colors.length],
    }));
    const start = performance.now();
    let frame = 0;
    const tick = (t: number) => {
      const elapsed = t - start;
      ctx.clearRect(0, 0, w, h);
      ctx.globalAlpha = Math.max(0, 1 - elapsed / DURATION_MS);
      for (const p of pieces) {
        p.vy += 0.25;
        p.x += p.vx;
        p.y += p.vy;
        p.spin += 0.2;
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x, p.y, p.size, p.size * Math.abs(Math.cos(p.spin)));
      }
      if (elapsed < DURATION_MS) frame = requestAnimationFrame(tick);
      else setDone(true);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  if (done) return null;
  return <canvas ref={ref} aria-hidden="true" data-testid="confetti" className="fixed inset-0 z-50 pointer-events-none" />;
};
