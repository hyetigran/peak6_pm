"use client";
import { useMemo, useRef, useState } from "react";

const N = 72; // samples between open and now

/** Deterministic intraday yes-chance walk (demo data — no candle feed yet), in %. */
function walk(pk: string, target: number): number[] {
  let seed = [...pk].reduce((a, c) => a + c.charCodeAt(0), 0);
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pts: number[] = []; let v = 50;
  for (let i = 0; i < N; i++) { v += (rnd() - 0.5) * 6 + (target - v) * 0.03; v = Math.min(98, Math.max(2, v)); pts.push(v); }
  pts[N - 1] = target;
  return pts;
}

const fmtTime = (ts: number) => new Date(ts * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

/** Yes-chance over the session: % on Y, time on X, crosshair + value readout on hover. */
export function Chart({ pk, mark, openTs }: { pk: string; mark: number | null; openTs?: number }) {
  const now = Math.floor(Date.now() / 1000);
  const start = openTs && openTs < now ? openTs : now - 6.5 * 3600;
  const pts = useMemo(() => walk(pk, mark ?? 50), [pk, mark]);
  const [hover, setHover] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);

  const onMove = (e: React.PointerEvent) => {
    const r = plotRef.current?.getBoundingClientRect(); if (!r) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    setHover(Math.round(frac * (N - 1)));
  };

  const xPct = (i: number) => (i / (N - 1)) * 100;
  const line = pts.map((v, i) => `${i === 0 ? "M" : "L"} ${xPct(i).toFixed(2)} ${(100 - v).toFixed(2)}`).join(" ");
  const cur = pts[N - 1];
  const h = hover;
  const hTs = h != null ? start + (h / (N - 1)) * (now - start) : null;
  const ticks = [0, 1 / 3, 2 / 3, 1].map((f) => ({ f, label: fmtTime(start + f * (now - start)) }));

  return (
    <div className="card-2" style={{ padding: 14 }}>
      <div className="hd" style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Yes price today</div>
        <div className="mono" style={{ fontSize: 13, color: "var(--ink-70)" }}>{h != null ? `${Math.round(pts[h])}¢ · ${fmtTime(hTs!)}` : `${Math.round(cur)}¢ now`}</div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "34px 1fr", gap: 6 }}>
        {/* Y axis — percentage */}
        <div className="mono" style={{ position: "relative", height: 150, fontSize: 10.5, color: "var(--ink-40)" }}>
          {[100, 75, 50, 25, 0].map((v) => (
            <span key={v} style={{ position: "absolute", right: 0, top: `${100 - v}%`, transform: "translateY(-50%)" }}>{v}¢</span>
          ))}
        </div>
        {/* plot */}
        <div ref={plotRef} onPointerMove={onMove} onPointerLeave={() => setHover(null)} style={{ position: "relative", height: 150, cursor: "crosshair" }}>
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block", overflow: "visible" }}>
            {[0, 25, 50, 75, 100].map((v) => (
              <line key={v} x1={0} x2={100} y1={100 - v} y2={100 - v} stroke="var(--line-2)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            ))}
            <path d={`${line} L 100 100 L 0 100 Z`} fill="var(--yes-soft)" opacity={0.5} stroke="none" />
            <path d={line} fill="none" stroke="var(--yes)" strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </svg>
          {h != null && (
            <>
              {/* crosshair snapped to the nearest sample */}
              <div style={{ position: "absolute", top: 0, bottom: 0, left: `${xPct(h)}%`, width: 1, background: "var(--ink-40)", pointerEvents: "none" }} />
              <div style={{ position: "absolute", left: `${xPct(h)}%`, top: `${100 - pts[h]}%`, width: 9, height: 9, borderRadius: "50%", background: "var(--yes)", border: "2px solid var(--card-2)", transform: "translate(-50%,-50%)", pointerEvents: "none" }} />
              <div className="mono" style={{ position: "absolute", top: 6, left: `${Math.min(86, Math.max(9, xPct(h)))}%`, transform: "translateX(-50%)", padding: "4px 8px", borderRadius: 7, background: "var(--chip-2)", border: "1px solid var(--line)", fontSize: 12, whiteSpace: "nowrap", pointerEvents: "none" }}>
              <b style={{ fontSize: 13 }}>{Math.round(pts[h])}¢</b> <span style={{ color: "var(--ink-60)" }}>{fmtTime(hTs!)}</span>
              </div>
            </>
          )}
        </div>
        {/* X axis — time */}
        <span />
        <div className="mono" style={{ position: "relative", height: 16, fontSize: 10.5, color: "var(--ink-40)" }}>
          {ticks.map((t, i) => (
            <span key={i} style={{ position: "absolute", left: `${t.f * 100}%`, transform: i === 0 ? "none" : i === ticks.length - 1 ? "translateX(-100%)" : "translateX(-50%)" }}>{t.label}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
