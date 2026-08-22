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
 * Per-ticker Switchboard feed pubkeys are NOT resolved here — those land with
 * the real oracle transport (#16); this resolves the oracle *program* only.
 */

// Mirror programs/meridian/src/constants.rs: the strict build requires
// normal_settlement_delay_secs >= 1200 and override_delay_secs >= 3600.
export const NORMAL_DELAY_FLOOR = 1200;
export const OVERRIDE_DELAY_FLOOR = 3600;

// Canonical devnet OpenBook deployment (ADR-0030); overridable for other clusters.
const CANONICAL_OPENBOOK_PROGRAMDATA = "DktN5HJ9uHKVRZ7FXGap4PEGVnEdc2VNBCXTt1AqJQYB";
const CANONICAL_OPENBOOK_SLOT = 282042596n;
const DEFAULT_PUBKEY = "11111111111111111111111111111111"; // PublicKey.default

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
  if (env.DEMO_MODE !== "devnet") {
    return {
      mode: "localnet",
      quoteMint: null,
      openbookProgramData: env.OPENBOOK_PROGRAMDATA ?? CANONICAL_OPENBOOK_PROGRAMDATA,
      openbookDeploymentSlot: BigInt(env.OPENBOOK_DEPLOYMENT_SLOT ?? CANONICAL_OPENBOOK_SLOT.toString()),
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
  const floor = (k: string, def: number, min: number): number => {
    const v = env[k] === undefined ? def : Number(env[k]);
    if (!Number.isFinite(v) || v < min) throw new Error(`${k}=${env[k]} is below the strict floor ${min}`);
    return v;
  };
  const shaHex = need("OPENBOOK_EXECUTABLE_SHA256");
  const sha = Buffer.from(shaHex, "hex");
  if (sha.length !== 32) throw new Error(`OPENBOOK_EXECUTABLE_SHA256 must be 32 bytes of hex (got ${sha.length})`);

  return {
    mode: "devnet",
    quoteMint: need("QUOTE_MINT"),
    openbookProgramData: env.OPENBOOK_PROGRAMDATA ?? CANONICAL_OPENBOOK_PROGRAMDATA,
    openbookDeploymentSlot: BigInt(env.OPENBOOK_DEPLOYMENT_SLOT ?? CANONICAL_OPENBOOK_SLOT.toString()),
    openbookExecutableSha256: sha,
    openbookUpgradeAuthority: need("OPENBOOK_UPGRADE_AUTHORITY"),
    metadataUri: need("METADATA_URI"),
    normalDelaySecs: floor("NORMAL_DELAY_SECS", NORMAL_DELAY_FLOOR, NORMAL_DELAY_FLOOR),
    overrideDelaySecs: floor("OVERRIDE_DELAY_SECS", OVERRIDE_DELAY_FLOOR, OVERRIDE_DELAY_FLOOR),
    oracleProgram: need("SWITCHBOARD_PROGRAM_ID"),
  };
}
