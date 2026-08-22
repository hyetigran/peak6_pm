# Publish and verify permanent metadata before mint creation

Meridian serializes each Yes/No metadata JSON document as RFC 8785 canonical UTF-8 bytes, hashes those exact bytes and each exact image, uploads all assets to production Arweave, and verifies each digest through two gateways before creating immutable Metaplex metadata. A fixed ordered manifest records URI and content SHA-256 values for Yes JSON, Yes image, No JSON, and No image; its domain-separated root is bound into the Outcome Market. Gateway verification is an off-chain preflight, while the program binds the submitted URI/content digests and validates the immutable Metaplex mint/metadata accounts. Upload or verification failure aborts creation; IPFS is only an explicit fallback with a raw CID and at least two independent pins, because an immutable on-chain URI cannot repair unavailable off-chain content.

## Status (2026-08-22)

**Decided; partially implemented (demo-only).** Shipped: `publish_metadata`
creates immutable Metaplex metadata (`is_mutable = false`,
`update_authority = Market PDA`) for both mints via a hand-rolled
`CreateMetadataAccountV3` CPI, invoked by `scripts/seed-demo.ts`. Not shipped:
RFC 8785 canonical serialization, JSON/image content hashing, Arweave upload,
two-gateway verification, the fixed ordered manifest and its root derivation
in-program, and abort-on-failure (the seed script catches and logs). The
`metadata_manifest_sha256` slot exists on the Market account but the demo binds a
placeholder. See ARCHITECTURE §5.3; tracked in #27.
