# Remove the V1 protocol-fee subsystem

Because V1 is protocol-fee-free, Meridian omits fee administrators, fee configuration and snapshots, treasury ledgers, collection instructions, and withdrawal powers instead of retaining dormant attack surface. Venue Markets are accepted only with zero maker and taker fees; because OpenBook v1.7 requires a fee-administrator public key, creation uses an intentionally unsignable sentinel proven by M0 rather than a Meridian-controlled signer. Adding fees later requires a new product and architecture revision rather than activating a hidden switch.
