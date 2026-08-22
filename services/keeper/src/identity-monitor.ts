/**
 * Identity-drift monitor (#25, ADR-0030, PRODUCTION_INFRA §5).
 *
 * Independently and continuously re-derives the on-chain executable identity of
 * the pinned programs — OpenBook (Config) and the settlement oracle adapter
 * (FeedVersion) — and alerts on any drift. A changed slot+hash under the same
 * authority is a verified upgrade surfaced for an explicit re-pin (ADR-0030,
 * never auto-adopted); anything else is fail-closed drift. Distinct from the
 * one-time capture in #8/#16: this watches identity over time so drift is
 * NOTICED, not just halted per-CPI.
 *
 * NOTE: the executable-hash check requires the BPF Upgradeable Loader
 * (ProgramData) — the devnet/mainnet canonical deployment. Localnet loads
 * OpenBook via `--bpf-program` (non-upgradeable, no ProgramData), so the hash
 * dimension is devnet-gated; owner/programdata/slot/authority drift is caught
 * wherever the program is upgradeable.
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  parseProgramAccount, parseProgramData, compareIdentity, BPF_UPGRADEABLE_LOADER,
  type ExecutableIdentity, type DriftStatus,
} from "./identity.js";
import { makeAlerter, type Alerter } from "./alerter.js";

/** The program is loaded non-upgradeably (localnet `--bpf-program`) — no
 *  ProgramData, so the executable-hash dimension is unavailable. */
export class NonUpgradeableError extends Error {}

// --- pinned-snapshot decoders (on-chain account offsets) ---

/** OpenBook identity pinned in Config (state/config.rs; offsets from the disc). */
export function pinnedOpenbookFromConfig(data: Buffer): ExecutableIdentity {
  // Guard the struct hasn't shrunk/reordered under us (offsets mirror config.rs).
  if (data.length < 469) throw new Error(`Config account too small (${data.length} < 469) — layout changed?`);
  return {
    // Config layout (state/config.rs): disc(8)+schema(1)+bump(1)+roles(8*32)+
    // quote_mint(32)+token_program(32)+quote_decimals(1)+mask(1)+paused(1) => 333.
    programId: new PublicKey(data.subarray(333, 365)).toBase58(),
    programdata: new PublicKey(data.subarray(365, 397)).toBase58(),
    deploymentSlot: data.readBigUInt64LE(397),
    executableSha256: data.subarray(405, 437).toString("hex"),
    upgradeAuthority: authOrNull(data.subarray(437, 469)),
  };
}

/** Oracle-adapter identity pinned in FeedVersion (state/feed_version.rs). */
export function pinnedOracleFromFeedVersion(data: Buffer): ExecutableIdentity {
  if (data.length < 215) throw new Error(`FeedVersion account too small (${data.length} < 215) — layout changed?`);
  return {
    programId: new PublicKey(data.subarray(79, 111)).toBase58(),
    programdata: new PublicKey(data.subarray(111, 143)).toBase58(),
    deploymentSlot: data.readBigUInt64LE(143),
    executableSha256: data.subarray(151, 183).toString("hex"),
    upgradeAuthority: authOrNull(data.subarray(183, 215)),
  };
}

/** All-zero pubkey == None (immutable) in the pinned snapshots. */
function authOrNull(buf: Buffer): string | null {
  const pk = new PublicKey(buf);
  return pk.equals(PublicKey.default) ? null : pk.toBase58();
}

// --- runner core ---

export interface MonitorTarget {
  name: string;
  pinned: ExecutableIdentity;
  readLive: () => Promise<ExecutableIdentity>;
}
export interface MonitorResult { name: string; status: DriftStatus | "error" | "unverifiable"; changed?: string[]; detail: string }

/** Compare each target's live identity to its pin; alert on drift/upgrade/error. */
export async function checkIdentities(opts: {
  targets: MonitorTarget[];
  alert: Alerter;
  onUpgrade?: (name: string) => void;
  /** When false (localnet), a non-upgradeable program is a warn, not a critical
   *  read failure — the hash dimension is simply unavailable there. Default true. */
  hashRequired?: boolean;
}): Promise<MonitorResult[]> {
  const hashRequired = opts.hashRequired ?? true;
  const results: MonitorResult[] = [];
  for (const t of opts.targets) {
    let live: ExecutableIdentity;
    try {
      live = await t.readLive();
    } catch (e) {
      if (!hashRequired && e instanceof NonUpgradeableError) {
        const detail = `${t.name} hash dimension unavailable (non-upgradeable loader) — expected on localnet`;
        await opts.alert({ level: "warn", source: "identity", title: `${t.name} identity unverifiable`, detail });
        results.push({ name: t.name, status: "unverifiable", detail });
        continue;
      }
      const detail = `could not read ${t.name} identity (fail closed): ${(e as Error).message}`;
      await opts.alert({ level: "critical", source: "identity", title: `${t.name} identity read failed`, detail });
      results.push({ name: t.name, status: "error", detail });
      continue;
    }
    const cmp = compareIdentity(t.pinned, live);
    if (cmp.status === "drift" || cmp.status === "upgrade") {
      await opts.alert({
        level: "critical", source: "identity",
        title: `${t.name} ${cmp.status}`, detail: cmp.detail,
        data: { changed: cmp.changed, pinned: serialize(t.pinned), live: serialize(live) },
      });
      if (cmp.status === "upgrade") opts.onUpgrade?.(t.name);
    }
    results.push({ name: t.name, status: cmp.status, changed: cmp.changed, detail: cmp.detail });
  }
  return results;
}

const serialize = (id: ExecutableIdentity) => ({ ...id, deploymentSlot: id.deploymentSlot.toString() });

// --- live-read via RPC (thin) ---

/** Read a program's live executable identity from the chain. */
export async function readLiveIdentity(conn: Connection, programId: string): Promise<ExecutableIdentity> {
  const prog = await conn.getAccountInfo(new PublicKey(programId));
  if (!prog) throw new Error(`program ${programId} not found`);
  if (!prog.owner.equals(BPF_UPGRADEABLE_LOADER)) {
    throw new NonUpgradeableError(`program ${programId} owner ${prog.owner.toBase58()} is not the upgradeable loader — non-upgradeable, no ProgramData to hash`);
  }
  const { programdata } = parseProgramAccount(prog.data);
  const pd = await conn.getAccountInfo(new PublicKey(programdata));
  if (!pd) throw new Error(`ProgramData ${programdata} not found`);
  const { deploymentSlot, upgradeAuthority, executableSha256 } = parseProgramData(pd.data);
  return { programId, programdata, deploymentSlot, upgradeAuthority, executableSha256 };
}

// --- entrypoint (only when run directly; tests import the pure parts) ---

const envInt = (name: string, dflt: number): number => Number(process.env[name] ?? String(dflt));

async function main() {
  const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
  const INTERVAL_MS = envInt("MONITOR_INTERVAL_SECS", 300) * 1000;
  const MERIDIAN_PID = new PublicKey(process.env.MERIDIAN_PID ?? "HiREMEBWNojy6KJNbMbww2YkRJEYLGMgndaKwXndK6ZD");
  // Hash dimension needs the upgradeable loader; localnet (--bpf-program) lacks it.
  const isLocalnet = /(127\.0\.0\.1|localhost)/.test(RPC);
  const hashRequired = process.env.MONITOR_HASH_REQUIRED ? process.env.MONITOR_HASH_REQUIRED === "true" : !isLocalnet;
  const conn = new Connection(RPC, "confirmed");
  const alert = makeAlerter({ webhookUrl: process.env.ALERT_WEBHOOK_URL, log: (m) => console.warn(`[monitor] ${m}`) });

  const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], MERIDIAN_PID)[0];
  const cfg = await conn.getAccountInfo(configPda);
  if (!cfg) throw new Error("Config not found — is Meridian deployed + initialized?");
  const targets: MonitorTarget[] = [];

  const obPin = pinnedOpenbookFromConfig(cfg.data);
  targets.push({ name: "OpenBook", pinned: obPin, readLive: () => readLiveIdentity(conn, obPin.programId) });

  // Oracle adapter identity: read one FeedVersion (all tickers pin the same adapter).
  const tickerId = envInt("MONITOR_TICKER", 7), versionId = envInt("MONITOR_VERSION", 1);
  const fvPda = PublicKey.findProgramAddressSync(
    [Buffer.from("transport_version"), Buffer.from([tickerId]), u32(versionId)], MERIDIAN_PID)[0];
  const fv = await conn.getAccountInfo(fvPda);
  if (fv) {
    const orPin = pinnedOracleFromFeedVersion(fv.data);
    targets.push({ name: "OracleAdapter", pinned: orPin, readLive: () => readLiveIdentity(conn, orPin.programId) });
  } else {
    console.warn(`[monitor] no FeedVersion for ticker ${tickerId} v${versionId} — oracle identity not monitored yet`);
  }

  const onUpgrade = (name: string) => console.warn(`[monitor] ${name} UPGRADE detected — reopen the architecture and re-pin (ADR-0030), do not auto-adopt`);
  console.log(`[monitor] identity-drift monitor up · ${targets.map((t) => t.name).join(", ")} · every ${INTERVAL_MS / 1000}s`);

  const ac = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => ac.abort());
  const tick = async () => {
    try {
      const results = await checkIdentities({ targets, alert, onUpgrade, hashRequired });
      const drift = results.filter((r) => r.status !== "ok");
      console.log(`[monitor] checked ${results.length}: ${drift.length ? drift.map((d) => `${d.name}=${d.status}`).join(", ") : "all ok"}`);
    } catch (e) { console.error(`[monitor] tick failed: ${(e as Error).message}`); }
  };
  await tick();
  const timer = setInterval(() => void tick(), INTERVAL_MS);
  ac.signal.addEventListener("abort", () => { clearInterval(timer); console.log("[monitor] stopped"); });
}

const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("[monitor] fatal:", e); process.exit(1); });
}
