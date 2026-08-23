"use client";
import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { getMarket, eventUrl } from "@/lib/api";

/** Legacy pubkey-addressed route — markets now live at /event/[ticker]?strike=…. */
export default function LegacyTradeRedirect() {
  const { market: pk } = useParams<{ market: string }>();
  const router = useRouter();
  useEffect(() => {
    getMarket(pk)
      .then((m) => router.replace(eventUrl(m)))
      .catch(() => router.replace("/markets"));
  }, [pk]);
  return <div className="wrap sub" style={{ padding: 40 }}>Redirecting…</div>;
}
