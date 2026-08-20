import "./globals.css";
import "@solana/wallet-adapter-react-ui/styles.css";
import type { Metadata } from "next";
import { WalletProvider } from "@/lib/wallet";
import { TopNav } from "@/components/TopNav";

export const metadata: Metadata = {
  title: "Meridian — trade the close",
  description: "Same-day binary Outcome Markets on MAG7 closes. $1.00 or nothing.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WalletProvider>
          <TopNav />
          <main>{children}</main>
        </WalletProvider>
      </body>
    </html>
  );
}
