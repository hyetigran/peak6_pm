# Meridian — End-to-End UI Walkthrough

A hands-on script to exercise the whole system through the browser on localnet.
Every step lists what to do and **what you should see**. Check the boxes as you go.

Runtime: ~15–20 min. Everything is devnet/test value — no real funds.

---

## 0. Bring the stack up

```bash
# From the repo root. DEMO_SETTLE adds two markets that close soon so you can
# watch settlement; DEMO_SETTLE_SECS gives you time to trade them first.
DEMO_SETTLE=1 DEMO_SETTLE_SECS=300 make demo
```

This starts, in order: validator (with OpenBook + Metaplex + Squads fixtures) → seed
(config, transports, 9 markets, token metadata, funds your demo wallet) → indexer `:8787`
→ keeper → market-maker → frontend `:3100`. Leave it running; `Ctrl-C` tears it all down.

- [ ] Terminal prints `Meridian demo is live` with Frontend / Indexer / RPC URLs.
- [ ] `curl -s localhost:8787/markets` returns 9 markets (7 MAG7 + TSLA $350 + GOOGL $200).
- [ ] Open **http://localhost:3100** — the landing page loads (dark theme, "Trade the close").

> Note the two closing-soon markets (**TSLA $350**, **GOOGL $200**) close ~5 min after
> seed. Do §7 (settlement) within that window, or just watch the keeper settle them.

---

## 1. Connect a wallet

- [ ] Top-right → **Connect wallet** → **Use a test wallet**.
- [ ] Chip shows a **TEST** badge, a SOL balance (auto-airdropped), and a short address.
- [ ] Click **+1000 USDC** → after a moment you hold test USDC (used for trading/minting).

*(The "Browser wallet (Phantom …)" path is for a real extension pointed at `localhost:8899`; the test wallet is the fast path for this walkthrough.)*

---

## 2. Markets page

- [ ] Go to **Markets**. Header shows stat pills: **Session** (Trading open), **Settles in** (countdown), **Open interest**.
- [ ] Ticker cards (AAPL, MSFT, NVDA, …) each list strike chips with a phase and OI.
- [ ] The bottom strip shows the daily timeline (08:00 strikes → 09:30 trading → 16:00 settle).

---

## 3. Open a market — live order book

- [ ] Click a strike chip on **AAPL $220** (a 6-hour market, so it won't close mid-test).
- [ ] Trade page: headline "Will AAPL close at or above $220 today?", a **TIME TO CLOSE** countdown.
- [ ] **YES** and **NO** hero cards show prices and implied % (e.g. YES ~80¢ / 80%, NO ~20¢ / 20%) — these come from the **market-maker's** live quotes.
- [ ] **YES book** and **NO book** show depth ladders (asks above the mark, bids below), ~25 shares per level.

*If the books are empty, the market-maker is still seeding — wait ~10s and refresh.*

---

## 4. Mint & redeem a Pair

- [ ] In the right panel, **Mint / redeem** section, set Shares to `10`.
- [ ] Click **Mint 10 pairs · $10**, approve. You spend 10 USDC and receive **10 YES + 10 NO**.
- [ ] The YES/NO book headers now show "10 held" for each side.
- [ ] Click **Redeem 10 pairs → $10**, approve. Your 10 YES + 10 NO burn and you get 10 USDC back.

Cross-check (optional): `curl -s localhost:8787/portfolio/<yourAddress>` reflects your token balances.

---

## 5. Trade — all four directional intents

Set a small size (e.g. `5`) each time and watch the book/marks move.

- [ ] **Buy YES (market):** Buy tab → YES → **Market** → Confirm. You take the best ask; you now hold YES and the mark ticks up.
- [ ] **Sell YES (limit):** Sell tab → YES → **Limit**, price a couple cents below the mark → Confirm. A resting ask appears in the YES book at your price.
- [ ] **Buy NO:** Buy tab → NO → set a limit → Confirm. Under the hood this **mints a pair and sells the YES** (you end up NO-sided). You now hold NO.
- [ ] **Sell NO:** Sell tab → NO → Confirm. This is the market-assisted `redeem_no_via_market` (buys YES from the book and redeems the pair). Your NO decreases.

- [ ] The **cost summary** box ("You pay $X for N YES… You win $N if AAPL closes…") updates with your inputs.

---

## 6. Portfolio

- [ ] Go to **Portfolio**. Metric cards: **Open positions**, **YES exposure**, **NO exposure**, **Ready to claim**.
- [ ] **Active positions** table lists your AAPL position with an **Open →** link back to the trade page.
- [ ] **Settled — redeemable** is empty for now (nothing settled yet).

---

## 7. Settlement & claim (time-boxed — do within the DEMO_SETTLE_SECS window)

Use a **closing-soon** market so you can see the whole close→settle→claim arc.

- [ ] Open **TSLA $350** (from Markets or `/trade`). Note the short TIME TO CLOSE.
- [ ] **Mint 10 pairs** here immediately (you now hold 10 YES + 10 NO), so you'll hold the winning side after settlement.
- [ ] Wait for the countdown to hit zero. Within a keeper tick (~5s past close) the market **auto-settles** — the page flips to **Settled**, showing the outcome (YES or NO won) and the official close.
- [ ] The winning side is now claimable. Click **Claim … winning → USDC** (or the **Claim →** link on Portfolio), approve. You receive $1.00 per winning token; the losing side is worth $0.

Cross-check: `curl -s localhost:8787/markets` shows TSLA/GOOGL `state=Settled` with an outcome.

---

## 8. Admin / Ops console

- [ ] Go to **Admin**. **Today · lifecycle** timeline shows Done/In-progress stages driven by real market state.
- [ ] **Markets & books** table lists all markets with phase, OI, and (for settled ones) the outcome.
- [ ] **Keeper & indexer** panel: **keeper online**, heartbeat, ticks, **Auto-settled** count, **Market-maker: online · N quoted · M orders**, indexer slot/lag.

Operator actions:

- [ ] **Pause minting** → the button flips to **Resume minting**, and a **"Minting paused by admin"** banner appears across the app (check any page). Click **Resume minting** to clear it.
- [ ] **Per-market Settle:** a market past its close shows a **Settle** button. (The keeper usually beats you to it; if one is still open, click Settle, set the close price, confirm — winner preview updates YES/NO live.)
- [ ] **Settle all closed:** header button settles every past-close market at once and reports the count.
- [ ] **Settlement override:** when a market is past close, **Open override** lets you finalize via the Override Authority path (two-equal evidenced values); otherwise it shows **Locked**.
- [ ] **Fee switches** are display-only with the note that fees are protocol-disabled (ADR-0001/0007) — expected, not a bug.

---

## 9. Token metadata (optional)

- [ ] Any YES/NO mint carries Metaplex metadata. If you import the test wallet into Phantom (localhost RPC), the tokens show as e.g. **"AAPL $220 YES" (mYES)** / **"AAPL $220 NO" (mNO)**.

---

## 10. Tear down

- [ ] `Ctrl-C` in the `make demo` terminal — validator, indexer, keeper, market-maker, and frontend all stop.

---

## Quick reference

| What | Where |
|---|---|
| Frontend | http://localhost:3100 (`/markets` `/trade` `/portfolio` `/history` `/admin`) |
| Indexer API | http://localhost:8787 (`/markets` `/book/:mkt` `/portfolio/:wallet` `/admin/keeper` `/admin/marketmaker`) |
| RPC | http://localhost:8899 |
| Faucet (USDC) | the **+1000 USDC** button, or `GET /faucet/:address` |

## If something looks off

- **Empty books / no prices** → market-maker still seeding; wait ~10s. Check `curl localhost:8787/admin/marketmaker` shows `running:true`.
- **Trades fail** → make sure you clicked **+1000 USDC** (need USDC) and the test wallet has SOL (auto-airdropped).
- **TSLA/GOOGL already closed before you traded** → they use the `DEMO_SETTLE_SECS` window; restart with a larger value.
- **Recovery-only banner** → the indexer is behind the chain; it catches up on the next poll. Exits stay open by design (ADR-0019).
