# QUARTERS — follow the money

**[quarters.fun](https://quarters.fun)** is a pay-to-play arcade on Solana. A play costs a quarter (0.0025 SOL), every score is a replay anyone can re-run, and every pot pays out on-chain.

This repo is published so you don't have to trust us. It contains the on-chain program, the verifier that decides scores, the deterministic game engines, and a one-command tool that re-executes any receipt on your own machine.

| | |
|---|---|
| Program (devnet) | `GixGVpDZpCxVcnpfWcSPwXF8rtjYrBGmmpkSdZq7kb7a` |
| Verifier | `https://quarters-verifier.fly.dev` |
| Status | **devnet public preview** — test SOL, no value, no token |

## Where every quarter goes

A quarter splits three ways *inside the program*, in the same transaction that inserts it. There is no "pending balance" anywhere and nothing to withdraw from.

```
insert_coin / start_run          programs/quarters/src/lib.rs
  quarter = cabinet stake, or the arcade default (0.0025 SOL)
  pot_cut      = quarter * 7000 / 10_000   → the cabinet's DailyPot PDA   (70%)
  operator_cut = quarter * 1500 / 10_000   → the cabinet deed's operator  (15%)
  house_cut    = the remainder             → the treasury                  (15%)
```

The pot is a program-owned account. Lamports leave it only through `settle_pot`, which:

1. can be called by **anyone** once the scoring period ends (permissionless),
2. verifies the winners passed in against the scores the verifier wrote on-chain,
3. pays the podium and tail by the published table, sweeps rounding dust and zero-winner pools to the treasury, and
4. can never run twice for the same pot.

Read it: [`settle_pot` in lib.rs](programs/quarters/src/lib.rs). Test it: [`tests/gate5-settle-edges.js`](tests/gate5-settle-edges.js) exercises the zero-winner sweep, the 4-winner tail split (400/7 bps each), wrong-count and wrong-identity rejection, and double-settle rejection against live devnet.

## How a score becomes true

```
score = f(committed_seed, your_inputs)
```

1. **Commit.** `insert_coin` (or a pack's `start_run`) stores `sha256(seed)` in a Credit account *before* you play. No re-rolls.
2. **Play.** The engine is deterministic: integer-only state, fixed 60 Hz timestep, seeded PRNG. The client records your input bitmask every tick.
3. **Submit the recording, not the score.** The client POSTs `{creditId, game, seed, inputsRLE, claimedScore, claimedHash}` to the verifier.
4. **Re-execute.** The verifier checks the seed against the on-chain commitment, replays the inputs from scratch with the same engine, and only if the score and state hash reproduce exactly does it call `submit_score` with its signer key. It also publishes the receipt.
5. **Anyone can re-run it.** See below.

Bots are a risk in any skill contest. The verifier flags runs whose input timing is machine-regular (`tasFlags` in `verifier/service.js`); flagged runs carry the flag on their public receipt and can be held from payout.

## Re-run a receipt yourself

```bash
npm install
node tools/replay.js https://quarters-verifier.fly.dev/replays/<creditId>.json
```

It loads the engine, replays the recorded inputs against the committed seed, and prints `REPRODUCED` or `MISMATCH`. Every receipt linked from a leaderboard or player page can be checked this way.

Public verifier endpoints:

```
GET /leaderboards               every cabinet's pot and top three, this period
GET /leaderboard/:cabinetId     one cabinet, straight from the chain
GET /player/:wallet             a wallet's standings and receipts
GET /replays/:creditId.json     the receipt
GET /health
```

## Packs and the session key

A pack (`open_tab`) escrows a deposit in a per-wallet Tab PDA and funds a throwaway **session key** *from that deposit*, inside the program. The session key signs `start_run` so plays need no wallet popup. Your wallet only ever pays the program's escrow; `close_tab` refunds the unspent balance any time. Tested end to end in [`tests/gate-tab.js`](tests/gate-tab.js).

## What's in here

```
programs/quarters/   the Anchor program (Rust)
idl/quarters.json    its IDL
verifier/            the verifier service + its determinism and API tests
engine/              24 deterministic game engines (plain JS, shared verbatim by client and verifier)
tools/replay.js      re-run any receipt
tests/               live devnet gate tests for every money path
docs/MONEY_ROUTE.md  the gate log
```

Not in here: the website and brand source, deploy keys, and infrastructure config.

## Verify the deployed program matches this source

```bash
anchor build --verifiable
solana-verify verify-from-repo -um --program-id GixGVpDZpCxVcnpfWcSPwXF8rtjYrBGmmpkSdZq7kb7a https://github.com/Based-LTD/quarters
```

(Verified-build publication happens with the mainnet deploy.)

## Contact

hello@quarters.fun · [@quartersfun](https://x.com/quartersfun) · BASED LTD

QUARTERS has no token. Anything claiming otherwise is fake.
