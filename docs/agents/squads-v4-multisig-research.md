# Squads V4 multisig research

Research date: 2026-08-19  
Scope: a 2-of-3 Solana program upgrade authority on devnet and a non-demo Manual Settlement Override authority  
Sources: first-party Squads, Solana, and Anchor documentation and source only

## Recommendation

Use an autonomous Squads Protocol V4 multisig with three members, threshold `2`, `configAuthority = null`, and an explicitly chosen vault index. Assign the derived vault PDA—not the Squads multisig account—to the Meridian program's Upgradeable Loader authority. The same mechanism can authorize an Anchor instruction: store a Squads vault PDA as the configured Override Authority, require that exact address as `Signer<'info>`, and execute the instruction through an approved Squads vault transaction.

For the M6 devnet proof, use vault index `0`, grant all three members Initiate/Vote/Execute permissions, and set `timeLock = 0` explicitly. This keeps the proof deterministic while preserving the 2-of-3 vote. A non-demo deployment should separately approve its timelock and key-custody policy. Prefer a separate autonomous multisig for the non-demo Override Authority so price attestation and program-upgrade control are distinct trust domains. A second vault index under one multisig gives a different authority address but retains the same members, threshold, and timelock.

## Verified findings

### Protocol identity and pinning

- Squads' official V4 repository lists the same program ID for Solana mainnet-beta and devnet: `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`. Its compiled program source declares the same ID. The official quickstart also documents devnet as a supported alternative with the required accounts already present. [Squads V4 repository](https://github.com/Squads-Protocol/v4#program-smart-contract-addresses), [program declaration](https://github.com/Squads-Protocol/v4/blob/main/programs/squads_multisig_program/src/lib.rs#L32-L35), [devnet quickstart](https://docs.squads.so/main/development/introduction/quickstart#set-your-environment-to-devnet-optional-1-minute)
- Squads states that V4 has been immutable since November 2024. The official repository identifies `64af7330413d5c85cbbccfd8c27a05d45b6e666f` as the final fully audited commit and documents comparing a reproducible local executable hash with the on-chain program hash. The deployment gate should still perform and retain that comparison instead of trusting an address alone. [Squads security](https://docs.squads.so/main/basics/security#immutable), [audited commit and verification commands](https://github.com/Squads-Protocol/v4#verifying-the-code)
- The first-party TypeScript package and current repository manifest report `@sqds/multisig` version `2.1.4`. Squads does not publish a separate dependency-pinning policy in the reviewed documentation. For reproducibility, pin exactly `2.1.4` rather than a caret range, commit the package-manager lockfile, and pass the expected Squads program ID explicitly to SDK operations that accept `programId`. [published package](https://www.npmjs.com/package/@sqds/multisig), [repository manifest](https://github.com/Squads-Protocol/v4/blob/main/sdk/multisig/package.json)
- Do not use the deprecated V3-era `@sqds/sdk`; the V4 SDK named by current Squads documentation is `@sqds/multisig`. [official SDK reference](https://docs.squads.so/main/development/reference/sdks)

The acceptance path should use the SDK or checked-in deployment scripts. Protocol availability on devnet is documented, but the reviewed primary sources do not make availability of any hosted devnet Squads UI a contract.

### A vault PDA can own and execute program upgrades

Yes. Solana's Upgradeable Loader stores a program's upgrade authority in its ProgramData account, and its upgrade instruction marks that authority as a required signer. Solana documents transferring this authority and inspecting the ProgramData address and authority with `solana program show`. [Solana deployment documentation](https://solana.com/docs/programs/deploying#program-management), [Upgradeable Loader instruction source](https://github.com/solana-labs/solana/blob/master/sdk/program/src/bpf_loader_upgradeable.rs#L205-L230)

Squads explicitly documents assigning program authority to a Squad, transferring buffer authority, creating an upgrade transaction, reaching the confirmation threshold, and executing the upgrade. Its V4 execution code derives the selected vault PDA, validates an approved proposal and timelock, then executes the stored message with the vault seeds. That supplies the PDA signer privilege required by the loader. [Squads program-management flow](https://docs.squads.so/main/navigating-your-squad/developers-assets/programs), [audited V4 execution source](https://github.com/Squads-Protocol/v4/blob/64af7330413d5c85cbbccfd8c27a05d45b6e666f/programs/squads_multisig_program/src/instructions/vault_transaction_execute.rs#L90-L133)

Use the official Safe Authority Transfer flow when available. Regardless of transfer path, acceptance depends on post-transfer on-chain inspection, not the submitted transaction alone.

### Proposal lifecycle

The deterministic V4 lifecycle is:

1. Read the multisig's current transaction index and create a vault transaction at the next index containing the exact loader or Meridian instruction.
2. Create its one-to-one proposal. Create it Active directly, or create a Draft and explicitly activate it.
3. Collect approvals from two distinct members with Vote permission. The proposal becomes Approved at the configured threshold.
4. Wait until the configured multisig timelock has elapsed from approval.
5. A member with Execute permission executes the vault transaction. Squads invokes the stored instructions with the selected vault PDA as signer and marks the proposal Executed.

The official quickstart demonstrates create/propose/approve/execute. The program source enforces Active status for approvals, the threshold transition, Approved status, the timelock, and Execute permission. [Squads quickstart](https://docs.squads.so/main/development/introduction/quickstart), [proposal creation source](https://github.com/Squads-Protocol/v4/blob/main/programs/squads_multisig_program/src/instructions/proposal_create.rs), [vote source](https://github.com/Squads-Protocol/v4/blob/main/programs/squads_multisig_program/src/instructions/proposal_vote.rs), [execution source](https://github.com/Squads-Protocol/v4/blob/main/programs/squads_multisig_program/src/instructions/vault_transaction_execute.rs)

Set `configAuthority = null`. Squads warns that a configured admin can override multisig configuration; the null/default value makes configuration changes follow the normal voting path. Give each of the three M6 keys all permissions so the proof does not depend on a particular key being the proposer or executor. [create-multisig guidance](https://docs.squads.so/main/development/typescript/instructions/create-multisig), [permissions](https://docs.squads.so/main/development/reference/permissions), [multisig account contract](https://docs.squads.so/main/development/reference/accounts#multisig)

### A vault PDA can be an Anchor Override Authority

Yes. Solana's runtime adds a caller-owned PDA to the valid signer set when the caller invokes another program with the correct seeds. Squads V4 does exactly that for its selected vault. Anchor's `Signer<'info>`/`#[account(signer)]` checks the runtime signer bit, while `#[account(address = ...)]` checks the expected key. [Solana CPI with PDA signers](https://solana.com/docs/core/cpi/cpi-with-pda), [Anchor account constraints](https://www.anchor-lang.com/docs/references/account-constraints), [Squads vault derivation](https://github.com/Squads-Protocol/v4/blob/main/sdk/multisig/src/pda.ts#L36-L52)

The Meridian instruction contract should therefore be equivalent to:

```rust
pub override_authority: Signer<'info>,
// plus a constraint or handler check:
// override_authority.key() == config.override_authority
```

The inner instruction must mark the vault PDA account meta as a signer. The member who executes the Squads proposal is only the top-level executor; it must not satisfy Meridian's Override Authority check directly. No Squads private key exists for the vault PDA.

This proves 2-of-3 authorization, not source truth. A Squads approval cannot make ordinary HTTP settlement evidence cryptographically authentic; the approved members remain the trust root for faithful evidence collection and normalization.

## Required deployment inputs

Known constants:

| Input | Required value |
| --- | --- |
| cluster | Solana devnet; record and assert the RPC's returned genesis hash |
| Squads V4 program ID | `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` |
| Squads audited source commit | `64af7330413d5c85cbbccfd8c27a05d45b6e666f` |
| TypeScript SDK | exact `@sqds/multisig@2.1.4` plus committed lockfile |
| M6 threshold | `2` |
| M6 members | exactly three distinct published pubkeys |
| M6 member permissions | each Initiate + Vote + Execute (`Permissions.all()`) |
| M6 config authority | null/default autonomous configuration |
| M6 vault index | `0` |
| M6 timelock | `0` seconds, explicitly recorded as devnet-only |

Deployment-specific values that must be supplied and published before transfer:

- RPC URL and observed devnet genesis hash;
- exact package-lock integrity and pinned Solana/Anchor/`solana-verify` tool versions;
- Squads create-key pubkey, derived multisig PDA, and independently re-derived vault PDA;
- three member pubkeys and custody owners;
- Meridian program ID, ProgramData address, current Upgradeable Loader authority, deployed slot, executable hash, and release commit;
- upgrade buffer address, buffer authority, spill/refund address, buffer executable hash, and intended release commit;
- every Squads transaction index, vault-transaction PDA, proposal PDA, approval signature, and execution signature;
- for non-demo Manual Settlement Override, the separately approved multisig/vault PDA and its members, threshold, permissions, config authority, and timelock.

## Non-waiverable acceptance gates

1. **Supply-chain gate:** clean install resolves exactly `@sqds/multisig@2.1.4`; the lockfile is unchanged; every SDK call is bound to the expected Squads ID. A reproducible build from the pinned audited Squads source produces the same executable hash as the immutable devnet deployment, using recorded tool versions.
2. **Derivation gate:** two independent implementations derive the same multisig and vault PDAs from the published inputs. The vault PDA is derived under the expected Squads program ID, and the multisig account itself is never used as an authority.
3. **Configuration gate:** finalized account reads show exactly three distinct members, threshold `2`, the approved permissions, `config_authority = Pubkey::default()`, the approved timelock, and vault index `0`. One vote cannot move a proposal to Approved; two distinct votes can.
4. **Authority-transfer gate:** finalized `ProgramData` inspection shows the Meridian program is owned by `BPFLoaderUpgradeab1e11111111111111111111111` and its upgrade authority equals the published vault PDA. The old deployer cannot upgrade after transfer.
5. **Loader execution gate:** write a devnet buffer for a reproducible, version-identical Meridian binary; prove its hash; transfer buffer authority to the same vault; create the exact upgrade proposal; approve with two members; execute through Squads; then prove the deployment slot changed and the on-chain executable hash still equals the expected hash. A one-approval execution attempt must fail without changing ProgramData.
6. **Anchor signer gate:** on an isolated fixture, a direct transaction signed by any one member must fail Meridian's Override Authority constraint. A Squads vault transaction carrying the same instruction must fail with one approval and succeed after two approvals, with the emitted event naming the configured vault PDA.
7. **Fail-closed gate:** any mismatch in cluster genesis hash, Squads ID/hash, SDK lock, PDA derivation, member set, threshold, permissions, config authority, timelock, ProgramData authority, buffer authority/hash, or decoded proposal instruction blocks M6 acceptance.

## Recommended documentation contract

> M6 uses the immutable Squads Protocol V4 deployment at `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` on Solana devnet. An autonomous three-member multisig (`configAuthority = null`) with threshold 2 and vault index 0 controls the Meridian Upgradeable Loader authority. Acceptance records the exact SDK and toolchain locks, independently re-derives the vault, verifies the Squads executable against the pinned audited source, verifies Meridian ProgramData authority on chain, and proves a two-approval loader upgrade end to end. A Squads vault PDA may also serve as an Anchor Override Authority because Squads signs downstream CPI instructions for that PDA. Non-demo Manual Settlement Override uses an explicitly published multisignature vault and retains the documented human trust assumption for HTTP evidence authenticity.

## Verification limit

The findings above were checked against current first-party documentation, published package metadata, and source. A direct read of the devnet program account was unavailable from this execution environment, so live program owner, ProgramData, deployment slot, and executable hash remain deployment-time gate outputs rather than claims in this note.
