import Link from "next/link";

// Landing page, ported from design_mockups "Meridian Landing.dc.html".
// Loom IDs come from env so the placeholders in the mockup never ship.
const VIDEOS = [
  {
    tag: "01 · WALKTHROUGH",
    tagClass: "landing-tag-blue",
    length: process.env.NEXT_PUBLIC_LANDING_VIDEO1_LENGTH ?? "4 min",
    title: "Product tour — markets to settlement",
    blurb: "A quick pass through the whole product: finding a market, reading a strike ladder, placing an order, and claiming after settlement.",
    id: process.env.NEXT_PUBLIC_LANDING_VIDEO1_ID,
    iframeTitle: "Meridian walkthrough",
  },
  {
    tag: "02 · DEEP DIVE",
    tagClass: "landing-tag-green",
    length: process.env.NEXT_PUBLIC_LANDING_VIDEO2_LENGTH ?? "12 min",
    title: "Design decisions and trade-offs",
    blurb: "Why the question leads, why the book has two views instead of two books, how the ops console exposes the oracle without scaring anyone, and the trade-offs I made at each breakpoint.",
    id: process.env.NEXT_PUBLIC_LANDING_VIDEO2_ID,
    iframeTitle: "Meridian deep dive",
  },
];

export default function Home() {
  return (
    <div className="landing">
      <header className="landing-header">
        <span className="brand-mark" />
        <span className="landing-brand">Meridian</span>
        <span className="landing-pill mono">Devnet demo</span>
        <Link href="/markets" className="landing-cta landing-cta-sm">Enter the markets</Link>
      </header>

      <section className="landing-hero">
        <div className="landing-eyebrow mono">MERIDIAN · TAKE-HOME SUBMISSION</div>
        <h1 className="landing-headline">Thank you for the opportunity to interview for the AI Engineer role at Peak6.</h1>
        <p className="landing-subhead">
          Riyanka, your deep understanding of financial services and clear product vision is both inspiring and appealing.
          I want to be a part of your team and help you ship a winning harness. James, building this Prediction Market on
          Solana was deeply interesting and intellectually rewarding.
        </p>
        <div className="landing-actions">
          <Link href="/markets" className="landing-cta">Enter the markets</Link>
          <a href="#walkthrough" className="landing-cta-ghost">Watch the walkthrough</a>
        </div>
      </section>

      <section id="walkthrough" className="landing-videos">
        {VIDEOS.map((v) => (
          <article key={v.tag} className="landing-video">
            <div className="landing-video-hd">
              <span className={`landing-tag mono ${v.tagClass}`}>{v.tag}</span>
              <span className="landing-length mono">{v.length}</span>
              <div className="landing-video-title">{v.title}</div>
            </div>
            <div className="landing-video-body">
              <p className="landing-blurb">{v.blurb}</p>
              <div className="landing-frame">
                {v.id ? (
                  <iframe src={`https://www.loom.com/embed/${v.id}`} allowFullScreen title={v.iframeTitle} />
                ) : (
                  <div className="landing-frame-empty mono">Video coming soon</div>
                )}
              </div>
            </div>
          </article>
        ))}
      </section>

      <section className="landing-footer">
        <div className="landing-callout">
          <div className="landing-callout-title">See it running</div>
          <Link href="/markets" className="landing-cta landing-cta-light">Enter the markets</Link>
        </div>
      </section>
    </div>
  );
}
