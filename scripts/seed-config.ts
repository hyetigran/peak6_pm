/**
 * Seed environment resolver (#24). Pure: maps process.env -> the identities and
 * timings the seed script needs, differing by target.
 *
 *   localnet  — the demo defaults: seed makes its own quote mint, delays are 0
 *               (the localnet build skips the floor check), and the transport is
 *               the harness mock feed.
 *   devnet    — the real values, and the strict on-chain settlement-delay floors
 *               a strict build (#23) enforces are validated here so a bad seed
 *               fails fast instead of at simulation.
 *
 * Kept dependency-light (only Buffer) so it unit-tests without a validator.
 * Per-ticker feeds are NOT resolved here — on devnet they are the Pyth adapter's
 * delivery PDAs (derived in seed-demo.ts); this resolves the oracle *program* only.
 */

// Mirror programs/meridian/src/constants.rs: the strict build requires
// normal_settlement_delay_secs >= 1200 and override_delay_secs >= 3600.
export const NORMAL_DELAY_FLOOR = 1200;
export const OVERRIDE_DELAY_FLOOR = 3600;
// Strict-build validate_schedule floors, mirrored from the program
// (instructions/market/mod.rs validate_schedule, not(localnet); the 1800 gap is
// a literal there, MAX_SESSION_SECS + MIN_ADD_STRIKE_LEAD_SECS are in constants.rs).
// The devnet seed pre-checks each market against these so a
// misconfigured window (e.g. a sub-floor DEMO_SETTLE) fails closed with a clear
// message instead of an opaque on-chain InvalidSchedule revert.
export const MINT_TO_TRADE_SECS = 1800;        // trade_open - mint_open must equal this
export const MAX_SESSION_SECS = 432_000;       // close - trade_open <= this (5 days)
export const MIN_ADD_STRIKE_LEAD_SECS = 1800;  // now <= close - this (close-30m)

/** Throw if (mint_open, trade_open, close) would be rejected by the strict build
 *  at `now`. All values are unix seconds. */
export function assertStrictSchedule(o: { mintOpen: number; tradeOpen: number; close: number; now: number }, label = "market"): void {
  const { mintOpen, tradeOpen, close, now } = o;
  if (!(mintOpen < tradeOpen && tradeOpen < close)) throw new Error(`${label}: schedule must be mint_open < trade_open < close`);
  if (tradeOpen - mintOpen !== MINT_TO_TRADE_SECS) throw new Error(`${label}: trade_open - mint_open must equal ${MINT_TO_TRADE_SECS}s (ADR-0033), got ${tradeOpen - mintOpen}`);
  if (close - tradeOpen > MAX_SESSION_SECS) throw new Error(`${label}: session ${close - tradeOpen}s exceeds MAX_SESSION_SECS ${MAX_SESSION_SECS}`);
  if (now > close - MIN_ADD_STRIKE_LEAD_SECS) throw new Error(`${label}: close ${close} is within the ${MIN_ADD_STRIKE_LEAD_SECS}s add-strike lead of now ${now} — the strict build rejects this (a sub-floor DEMO_SETTLE window?)`);
}

// Canonical devnet OpenBook deployment (ADR-0030); overridable for other clusters.
const CANONICAL_OPENBOOK_PROGRAMDATA = "DktN5HJ9uHKVRZ7FXGap4PEGVnEdc2VNBCXTt1AqJQYB";
const CANONICAL_OPENBOOK_SLOT = 282042596n;
const DEFAULT_PUBKEY = "11111111111111111111111111111111"; // PublicKey.default
// Circle's devnet USDC (ADR-0015); the devnet default, overridable via QUOTE_MINT.
const CIRCLE_DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

export interface SeedConfig {
  mode: "localnet" | "devnet";
  quoteMint: string | null; // null -> seed creates a mint (localnet)
  openbookProgramData: string;
  openbookDeploymentSlot: bigint;
  openbookExecutableSha256: Buffer; // exactly 32 bytes
  openbookUpgradeAuthority: string;
  metadataUri: string;
  normalDelaySecs: number;
  overrideDelaySecs: number;
  oracleProgram: string | null; // null -> harness mock feed (localnet)
}

type Env = Record<string, string | undefined>;

export function resolveSeedConfig(env: Env): SeedConfig {
  // OpenBook deployment identity is the same shape in both modes.
  const openbookProgramData = env.OPENBOOK_PROGRAMDATA ?? CANONICAL_OPENBOOK_PROGRAMDATA;
  const openbookDeploymentSlot = BigInt(env.OPENBOOK_DEPLOYMENT_SLOT ?? CANONICAL_OPENBOOK_SLOT.toString());

  if (env.DEMO_MODE !== "devnet") {
    return {
      mode: "localnet",
      quoteMint: null,
      openbookProgramData,
      openbookDeploymentSlot,
      openbookExecutableSha256: Buffer.alloc(32, 0xaa), // placeholder ok — localnet doesn't pin identity
      openbookUpgradeAuthority: env.OPENBOOK_UPGRADE_AUTHORITY ?? DEFAULT_PUBKEY,
      metadataUri: env.METADATA_URI ?? "https://meridian.markets",
      normalDelaySecs: 0,
      overrideDelaySecs: 0,
      oracleProgram: null,
    };
  }

  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`devnet seed requires ${k}`);
    return v;
  };
  const requireAtLeast = (k: string, floor: number): number => {
    const v = env[k] === undefined ? floor : Number(env[k]);
    if (!Number.isFinite(v) || v < floor) throw new Error(`${k}=${env[k]} is below the strict floor ${floor}`);
    return v;
  };
  const shaHex = need("OPENBOOK_EXECUTABLE_SHA256");
  const sha = Buffer.from(shaHex, "hex");
  if (sha.length !== 32) throw new Error(`OPENBOOK_EXECUTABLE_SHA256 must be 32 bytes of hex (got ${sha.length})`);

  return {
    mode: "devnet",
    quoteMint: env.QUOTE_MINT || CIRCLE_DEVNET_USDC, // Circle devnet USDC by default (ADR-0015); empty falls back too
    openbookProgramData,
    openbookDeploymentSlot,
    openbookExecutableSha256: sha,
    openbookUpgradeAuthority: need("OPENBOOK_UPGRADE_AUTHORITY"),
    metadataUri: need("METADATA_URI"),
    normalDelaySecs: requireAtLeast("NORMAL_DELAY_SECS", NORMAL_DELAY_FLOOR),
    overrideDelaySecs: requireAtLeast("OVERRIDE_DELAY_SECS", OVERRIDE_DELAY_FLOOR),
    oracleProgram: need("ORACLE_PROGRAM_ID"), // the Pyth adapter program id (owner-pin, ADR-0030)
  };
}
