"use client";

import { useEffect, useRef } from "react";

// Animated isoline contour plot: a handful of drifting 2D wave sources sum into a
// scalar field, sampled on a coarse grid each frame and traced at several
// thresholds with marching squares. One extra source follows the pointer.
// Purely decorative — honours prefers-reduced-motion (renders one static frame).

type Source = { x: number; y: number; vx: number; vy: number; freq: number; amp: number; phase: number };

const CELL = 14; // grid spacing in CSS px — the only real knob for cost vs. detail
const LEVELS = [-0.9, -0.6, -0.3, 0, 0.3, 0.6, 0.9];

export default function ContourField({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 0, h = 0, dpr = 1, cols = 0, rows = 0;
    let field = new Float32Array(0);
    const sources: Source[] = [];
    const pointer = { x: -1e4, y: -1e4, tx: -1e4, ty: -1e4, active: false };
    let raf = 0;
    let t = 0;

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      w = Math.max(1, r.width);
      h = Math.max(1, r.height);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(w / CELL) + 1;
      rows = Math.ceil(h / CELL) + 1;
      field = new Float32Array(cols * rows);
      if (sources.length === 0) {
        for (let i = 0; i < 5; i++) {
          sources.push({
            x: Math.random() * w,
            y: Math.random() * h,
            vx: (Math.random() - 0.5) * 18,
            vy: (Math.random() - 0.5) * 18,
            freq: 0.012 + Math.random() * 0.014,
            amp: 0.6 + Math.random() * 0.5,
            phase: Math.random() * Math.PI * 2,
          });
        }
      }
    };

    const sample = () => {
      const n = sources.length;
      for (let j = 0; j < rows; j++) {
        const y = j * CELL;
        for (let i = 0; i < cols; i++) {
          const x = i * CELL;
          let v = 0;
          for (let k = 0; k < n; k++) {
            const s = sources[k];
            const dx = x - s.x, dy = y - s.y;
            v += s.amp * Math.sin(Math.sqrt(dx * dx + dy * dy) * s.freq - t * 1.4 + s.phase);
          }
          if (pointer.active) {
            const dx = x - pointer.x, dy = y - pointer.y;
            const d = Math.sqrt(dx * dx + dy * dy);
            v += 1.1 * Math.sin(d * 0.03 - t * 2.2) * Math.exp(-d / 260);
          }
          field[j * cols + i] = v / n;
        }
      }
    };

    // Linear interpolation of the crossing point along a cell edge.
    const lerp = (a: number, b: number, lvl: number) => {
      const d = b - a;
      return Math.abs(d) < 1e-6 ? 0.5 : (lvl - a) / d;
    };

    const trace = (lvl: number) => {
      ctx.beginPath();
      for (let j = 0; j < rows - 1; j++) {
        for (let i = 0; i < cols - 1; i++) {
          const tl = field[j * cols + i], tr = field[j * cols + i + 1];
          const bl = field[(j + 1) * cols + i], br = field[(j + 1) * cols + i + 1];
          const idx = (tl > lvl ? 8 : 0) | (tr > lvl ? 4 : 0) | (br > lvl ? 2 : 0) | (bl > lvl ? 1 : 0);
          if (idx === 0 || idx === 15) continue;
          const x0 = i * CELL, y0 = j * CELL;
          // edge midpoints: top, right, bottom, left
          const top = [x0 + lerp(tl, tr, lvl) * CELL, y0];
          const right = [x0 + CELL, y0 + lerp(tr, br, lvl) * CELL];
          const bottom = [x0 + lerp(bl, br, lvl) * CELL, y0 + CELL];
          const left = [x0, y0 + lerp(tl, bl, lvl) * CELL];
          const seg = (a: number[], b: number[]) => { ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); };
          switch (idx) {
            case 1: case 14: seg(left, bottom); break;
            case 2: case 13: seg(bottom, right); break;
            case 3: case 12: seg(left, right); break;
            case 4: case 11: seg(top, right); break;
            case 5: seg(top, left); seg(bottom, right); break;
            case 6: case 9: seg(top, bottom); break;
            case 7: case 8: seg(top, left); break;
            case 10: seg(top, right); seg(left, bottom); break;
          }
        }
      }
      ctx.stroke();
    };

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      sample();
      ctx.lineWidth = 1;
      ctx.lineJoin = "round";
      for (const lvl of LEVELS) {
        // zero line brightest; outer levels fade so the field reads as depth
        const a = 0.34 - Math.abs(lvl) * 0.22;
        ctx.strokeStyle = `oklch(0.72 0.12 255 / ${a.toFixed(3)})`;
        trace(lvl);
      }
    };

    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      t += dt;
      for (const s of sources) {
        s.x += s.vx * dt; s.y += s.vy * dt;
        if (s.x < -60 || s.x > w + 60) s.vx *= -1;
        if (s.y < -60 || s.y > h + 60) s.vy *= -1;
      }
      pointer.x += (pointer.tx - pointer.x) * 0.12;
      pointer.y += (pointer.ty - pointer.y) * 0.12;
      draw();
      raf = requestAnimationFrame(tick);
    };

    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      pointer.tx = e.clientX - r.left;
      pointer.ty = e.clientY - r.top;
      if (!pointer.active) { pointer.x = pointer.tx; pointer.y = pointer.ty; pointer.active = true; }
    };
    const onLeave = () => { pointer.active = false; };

    const ro = new ResizeObserver(() => { resize(); if (reduced) draw(); });
    ro.observe(canvas);
    resize();

    if (reduced) {
      draw();
    } else {
      window.addEventListener("pointermove", onMove, { passive: true });
      document.addEventListener("pointerleave", onLeave);
      raf = requestAnimationFrame(tick);
    }

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
