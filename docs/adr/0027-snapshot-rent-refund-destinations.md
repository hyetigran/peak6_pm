# Snapshot rent-refund destinations

Every operator-funded closable account snapshots its rent-refund destination when the related market is created, and any recoverable Solana rent returns only to that address. User-funded OpenBook account rent returns to the user payer or owner under the venue's supported closure path. Collateral authorities, current role holders, and fee recipients are never implicit refund destinations, and M0 must verify every supported close instruction and destination before account closure is exposed.
