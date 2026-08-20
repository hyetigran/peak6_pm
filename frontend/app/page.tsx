import Link from "next/link";

export default function Landing() {
  return (
    <div className="wrap" style={{ padding: "72px 24px 48px" }}>
      <div style={{ maxWidth: 640 }}>
        <div className="eyebrow" style={{ marginBottom: 14 }}>Same-day · MAG7 · non-custodial</div>
        <h1 style={{ fontSize: 46, lineHeight: 1.05 }}>Trade the close.<br />$1.00 or nothing.</h1>
        <p className="sub" style={{ fontSize: 17, marginTop: 18 }}>
          Binary Outcome Markets on whether a MAG7 stock&rsquo;s official close is at or above a
          strike. Fully collateralized Yes/No tokens, one Yes/USDC book for both sides, settled
          from a single on-chain record per ticker and day.
        </p>
        <div style={{ display: "flex", gap: 12, marginTop: 30 }}>
          <Link href="/markets"><button className="btn btn-yes">Explore markets</button></Link>
          <Link href="/portfolio"><button className="btn btn-ghost">Your portfolio</button></Link>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16, marginTop: 64 }}>
        {[
          ["Mint a Pair", "Deposit $1 of USDC, get one Yes and one No token. Together they&rsquo;re always worth exactly $1."],
          ["Trade either side", "Buy or sell Yes or No on a single OpenBook order book. The No price mirrors Yes — they sum to $1."],
          ["Settle & redeem", "At the official close, the winning token pays $1 and the loser pays 0. Redeem any time — winners never expire."],
        ].map(([h, b]) => (
          <div key={h} className="card" style={{ padding: 22 }}>
            <h2 style={{ fontSize: 17 }}>{h}</h2>
            <p className="sub" style={{ marginTop: 8, fontSize: 13.5 }} dangerouslySetInnerHTML={{ __html: b }} />
          </div>
        ))}
      </div>
    </div>
  );
}
