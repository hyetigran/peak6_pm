"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { getMarkets, marketPhase, type Market } from "@/lib/api";
import { strikeUsd, usd, countdown } from "@/lib/format";

type RailKey = "all" | "daily";

interface RailItem {
  key: string;
  label: string;
  icon: string;
  count?: number | "live";
  enabled?: boolean;
  dividerBefore?: boolean;
}

interface MarketGroup {
  id: string;
  ticker: string;
  markets: Market[];
  allMarkets: Market[];
  primary: Market;
}

const REF: Record<string, { name: string }> = {
  AAPL: { name: "Apple" },
  AMZN: { name: "Amazon" },
  GOOGL: { name: "Alphabet" },
  META: { name: "Meta Platforms" },
  MSFT: { name: "Microsoft" },
  NVDA: { name: "Nvidia" },
  TSLA: { name: "Tesla" },
};

const RAIL_ITEMS: RailItem[] = [
  { key: "all", label: "All", icon: "grid", count: "live", enabled: true },
  { key: "daily", label: "Daily", icon: "calendar", count: "live", enabled: true },
  { key: "weekly", label: "Weekly", icon: "bars" },
  { key: "monthly", label: "Monthly", icon: "trend" },
  { key: "stocks", label: "Stocks", icon: "coins", dividerBefore: true },
  { key: "earnings", label: "Earnings", icon: "dot" },
  { key: "indices", label: "Indices", icon: "badge" },
  { key: "commodities", label: "Commodities", icon: "drop" },
  { key: "forex", label: "Forex", icon: "swap" },
  { key: "privates", label: "Privates", icon: "screen" },
  { key: "acquisitions", label: "Acquisitions", icon: "deal" },
  { key: "ipos", label: "IPOs", icon: "rocket" },
  { key: "rates", label: "Fed Rates", icon: "percent" },
  { key: "prediction", label: "Prediction Markets", icon: "dial" },
  { key: "treasuries", label: "Treasuries", icon: "cash" },
  { key: "kpis", label: "KPIs", icon: "bars" },
];

const FILTERS = ["All", "AAPL", "AMZN", "GOOGL", "META", "MSFT", "NVDA", "TSLA"];

function tradingDayLabel(day: number) {
  const year = Math.floor(day / 10000);
  const month = Math.floor(day / 100) % 100;
  const date = day % 100;
  return new Date(Date.UTC(year, month - 1, date)).toLocaleDateString("en-US", { month: "long", day: "numeric" });
}

function filterMarket(m: Market, filter: string) {
  if (filter !== "All") return m.ticker === filter;
  return true;
}

function previewStrikes(markets: Market[]) {
  const ordered = markets.slice().sort((a, b) => Math.abs((a.mark ?? 50) - 50) - Math.abs((b.mark ?? 50) - 50));
  const preview = ordered.slice(0, 3);
  return preview.sort((a, b) => Number(BigInt(a.strike_1e6) - BigInt(b.strike_1e6)));
}

function buildGroups(markets: Market[]): MarketGroup[] {
  const grouped = new Map<string, Market[]>();
  for (const m of markets) {
    const key = `${m.ticker}:${m.trading_day}`;
    const group = grouped.get(key) ?? [];
    group.push(m);
    grouped.set(key, group);
  }

  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, ms]) => {
      const sorted = ms.slice().sort((a, b) => Number(BigInt(a.strike_1e6) - BigInt(b.strike_1e6)));
      const primary = sorted.slice().sort((a, b) => Math.abs((a.mark ?? 50) - 50) - Math.abs((b.mark ?? 50) - 50))[0] ?? sorted[0];
      return { id: key, ticker: primary.ticker, markets: previewStrikes(sorted), allMarkets: sorted, primary };
    });
}

function RailIcon({ type }: { type: string }) {
  return <span className={`market-rail-icon market-rail-icon-${type}`} aria-hidden="true" />;
}

function RailButton({ item, active, liveCount, onClick }: { item: RailItem; active: boolean; liveCount: number; onClick: () => void }) {
  const count = item.count === "live" ? liveCount : item.count;
  const content = (
    <>
      <RailIcon type={item.icon} />
      <span className="market-rail-label">{item.label}</span>
      {count != null && count > 0 && <span className="market-rail-count mono">{count}</span>}
    </>
  );
  return (
    <>
      {item.dividerBefore && <div className="market-rail-divider" />}
      {item.enabled ? (
        <button type="button" className="market-rail-item" aria-pressed={active} onClick={onClick}>
          {content}
        </button>
      ) : (
        <div className="market-rail-item market-rail-item-disabled" aria-disabled="true">
          {content}
        </div>
      )}
    </>
  );
}

function MarketCard({ group }: { group: MarketGroup }) {
  const ref = REF[group.ticker] ?? { name: "Market" };
  const primaryMark = group.primary.mark != null ? Math.round(group.primary.mark) : null;
  const volume = group.allMarkets.reduce((a, m) => a + BigInt(m.volume_atoms ?? m.collateral_liability_atoms), 0n);
  const day = tradingDayLabel(group.primary.trading_day);
  const phase = marketPhase(group.primary);
  const tone = primaryMark == null ? "neutral" : primaryMark >= 50 ? "yes" : "no";
  const href = `/trade/${group.primary.pubkey}`;

  return (
    <Link href={href} className="market-card" aria-label={`Trade ${ref.name} ${group.ticker} daily close markets`}>
      <div className="market-card-head">
        <div className="market-card-avatar" data-tone={tone}>{group.ticker.slice(0, 3)}</div>
        <div className="market-card-title-wrap">
          <h2>{ref.name} ({group.ticker}) closes above __ on {day}?</h2>
          <div className="market-card-meta mono">
            <span>{group.allMarkets.length} strike{group.allMarkets.length > 1 ? "s" : ""}</span>
            <span>Finance Daily</span>
          </div>
        </div>
      </div>

      <div className="market-strike-list">
        {group.markets.map((m) => {
          const yes = m.mark != null ? Math.round(m.mark) : null;
          const no = yes != null ? 100 - yes : null;
          return (
            <div key={m.pubkey} className="market-strike-row">
              <span className="market-strike-price mono">{strikeUsd(m.strike_1e6)}</span>
              <span className="market-strike-prob mono">{yes != null ? `${yes}%` : "-"}</span>
              <span className="market-outcome market-outcome-yes">Yes</span>
              <span className="market-outcome market-outcome-no">No</span>
              <span className="market-strike-no mono">{no != null ? `${no}%` : "-"}</span>
            </div>
          );
        })}
      </div>

      <div className="market-card-foot">
        <span className="market-new">NEW</span>
        <span>{phase}</span>
        <span>Daily</span>
        <span className="mono">${usd(volume, 0)} OI</span>
      </div>
    </Link>
  );
}

function MarketsSkeleton() {
  return (
    <div className="markets-browser markets-skeleton" aria-busy="true" aria-label="Loading markets">
      <aside className="market-rail markets-skeleton-rail" aria-hidden="true">
        {Array.from({ length: 14 }).map((_, i) => (
          <div key={i} className="market-rail-item">
            <div className="skeleton-line skeleton-line-icon" />
            <div className="skeleton-line skeleton-line-rail" />
            {i < 2 && <div className="skeleton-line skeleton-line-count" />}
          </div>
        ))}
      </aside>

      <section className="markets-main">
        <div className="markets-subnav">
          <div className="skeleton-line skeleton-line-heading" />
          <div className="markets-filter-row" aria-hidden="true">
            {FILTERS.map((filter) => (
              <div key={filter} className="skeleton-line skeleton-line-filter" />
            ))}
          </div>
        </div>

        <div className="markets-summary" aria-hidden="true">
          {[0, 1, 2].map((item) => (
            <div key={item}>
              <div className="skeleton-line skeleton-line-label" />
              <div className="skeleton-line skeleton-line-summary" />
            </div>
          ))}
        </div>

        <div className="markets-scroll">
          <div className="markets-grid">
            {Array.from({ length: 6 }).map((_, card) => (
              <div key={card} className="market-card markets-skeleton-card" aria-hidden="true">
                <div className="market-card-head">
                  <div className="skeleton-line skeleton-line-market-avatar" />
                  <div className="market-card-title-wrap">
                    <div className="skeleton-line skeleton-line-card-title" />
                    <div className="skeleton-line skeleton-line-card-meta" />
                  </div>
                </div>
                <div className="market-strike-list">
                  {[0, 1, 2].map((row) => (
                    <div key={row} className="market-strike-row">
                      <div className="skeleton-line skeleton-line-strike-price" />
                      <div className="skeleton-line skeleton-line-strike-prob" />
                      <div className="skeleton-line skeleton-line-market-chip" />
                      <div className="skeleton-line skeleton-line-market-chip" />
                      <div className="skeleton-line skeleton-line-strike-prob" />
                    </div>
                  ))}
                </div>
                <div className="market-card-foot">
                  <div className="skeleton-line skeleton-line-foot-a" />
                  <div className="skeleton-line skeleton-line-foot-b" />
                  <div className="skeleton-line skeleton-line-foot-c" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

export default function Markets() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [rail, setRail] = useState<RailKey>("daily");
  const [activeFilter, setActiveFilter] = useState("All");
  const [, tick] = useState(0);

  useEffect(() => {
    const load = () => getMarkets("live")
      .then((d) => { setMarkets(d.markets); setErr(null); })
      .catch((e) => { console.error(e); setErr("Something went wrong"); })
      .finally(() => setLoaded(true));
    load();
    const t = setInterval(load, 3000);
    const c = setInterval(() => tick((x) => x + 1), 1000);
    return () => {
      clearInterval(t);
      clearInterval(c);
    };
  }, []);

  const visibleMarkets = useMemo(() => markets.filter((m) => filterMarket(m, activeFilter)), [markets, activeFilter]);
  const marketGroups = useMemo(() => buildGroups(visibleMarkets), [visibleMarkets]);
  const live = markets.filter((m) => marketPhase(m) === "Trading");
  const openInterest = markets.reduce((a, m) => a + BigInt(m.collateral_liability_atoms), 0n);
  const nextClose = markets.filter((m) => !m.settled_ts && m.close_ts > Date.now() / 1000)
    .map((m) => m.close_ts).sort((a, b) => a - b)[0];
  const session = live.length > 0 ? "Trading open" : markets.length ? "Minting / pre-market" : "No session";

  if (!loaded) return <MarketsSkeleton />;

  return (
    <div className="markets-browser">
      <aside className="market-rail" aria-label="Market categories">
        {RAIL_ITEMS.map((item) => (
          <RailButton
            key={item.key}
            item={item}
            active={rail === item.key}
            liveCount={markets.length}
            onClick={() => item.enabled && setRail(item.key as RailKey)}
          />
        ))}
      </aside>

      <section className="markets-main">
        <div className="markets-subnav">
          <h1>Finance Daily</h1>
          <div className="markets-filter-row" aria-label="Finance filters">
            {FILTERS.map((filter) => (
              <button
                key={filter}
                type="button"
                className="markets-filter-pill"
                aria-pressed={activeFilter === filter}
                onClick={() => setActiveFilter(filter)}
              >
                {filter}
              </button>
            ))}
          </div>
        </div>

        <div className="markets-summary" aria-label="Market session summary">
          <div>
            <span>Session</span>
            <strong>{session}</strong>
          </div>
          {nextClose && (
            <div>
              <span>Settles in</span>
              <strong className="mono">{countdown(nextClose)}</strong>
            </div>
          )}
          <div>
            <span>Open interest</span>
            <strong className="mono">${usd(openInterest, 0)}</strong>
          </div>
        </div>

        <div className="markets-scroll">
          {err && <div className="card markets-state" style={{ color: "var(--no)" }}>Indexer offline ({err}). Start it with <code className="mono">make demo</code>.</div>}
          {!err && markets.length === 0 && <div className="card markets-state sub">No markets yet. The operator has not created today&apos;s strikes.</div>}
          {!err && markets.length > 0 && marketGroups.length === 0 && <div className="card markets-state sub">No Finance Daily markets match this filter.</div>}

          <div className="markets-grid">
            {marketGroups.map((group) => <MarketCard key={group.id} group={group} />)}
          </div>
        </div>
      </section>
    </div>
  );
}
