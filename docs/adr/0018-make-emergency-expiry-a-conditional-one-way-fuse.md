# Make Emergency Expiry a conditional one-way fuse

V1 exposes Emergency Expiry only if M0 proves the pinned OpenBook operation and the complete post-expiry recovery path. A previously paused, pre-close Outcome Market may be expired only by the Pause Authority through the dedicated venue-close signer, after which an immutable flag and reason keep it permanently paused while cancellation, event consumption, fund settlement, Pair Redemption, Settlement, and Outcome Redemption remain available; failure of any recovery test removes the instruction from V1.
